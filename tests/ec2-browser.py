#!/usr/bin/env python3
"""Real Firefox Dashboard/SSH smoke test; run with a Selenium-enabled interpreter.

Use a new private --output-dir for each run. --credentials accepts a protected
JSON/env file or '-' for JSON on stdin. JSON fields: admin_password,
viewer_password, optional admin_username/viewer_username. Env form uses
DEMO_ADMIN_PASSWORD and DEMO_VIEWER_PASSWORD. Use dedicated verification users:
the logout checks revoke every session belonging to each supplied account.
Credentials never enter argv.
Prefer dedicated verification accounts: UI logout revokes that account's tokens.
The API, WebSocket and SSH remain real; the WebSocket observer only records
incoming frame metadata and the output of this test's bounded shell command.
"""
import argparse
import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import sys
from urllib.parse import urlsplit


OBSERVE = r"""
window.ztEc2Browser = {sockets: [], errors: 0};
addEventListener('error', () => window.ztEc2Browser.errors++);
addEventListener('unhandledrejection', () => window.ztEc2Browser.errors++);
const NativeSocket = window.WebSocket;
window.WebSocket = class extends NativeSocket {
  constructor(...args) {
    super(...args);
    const state = {ready: false, closed: false, error: false, output: '', user: null};
    window.ztEc2Browser.sockets.push(state);
    this.addEventListener('message', event => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === 'READY') { state.ready = true; state.user = frame.ssh_username; }
        if (frame.type === 'ERROR') state.error = true;
        if (frame.type === 'DATA' && typeof frame.data === 'string')
          state.output = (state.output + frame.data).slice(-20000);
      } catch {}
    });
    this.addEventListener('close', event => { state.closed = true; state.code = event.code; });
    this.addEventListener('error', () => { state.error = true; });
  }
};
"""


def credentials(source):
    if source == '-':
        raw = sys.stdin.read()
    else:
        path = Path(source)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise ValueError('Credentials must be an owner-only regular file owned by the current user')
        raw = path.read_text()
    if raw.lstrip().startswith('{'):
        data = json.loads(raw)
    else:
        data = dict(line.split('=', 1) for line in raw.splitlines()
                    if '=' in line and not line.lstrip().startswith('#'))
    result = {
        'admin_password': data.get('admin_password') or data.get('DEMO_ADMIN_PASSWORD'),
        'viewer_password': data.get('viewer_password') or data.get('DEMO_VIEWER_PASSWORD'),
        'admin_username': data.get('admin_username', 'demo-admin'),
        'viewer_username': data.get('viewer_username', 'demo-viewer'),
    }
    if any(not isinstance(value, str) or not value for value in result.values()):
        raise ValueError('Missing Dashboard account credentials')
    return result


def driver_path(explicit):
    if explicit:
        return explicit
    existing = shutil.which('geckodriver')
    if existing:
        return existing
    cached = sorted((Path.home() / '.cache/selenium/geckodriver').glob('**/geckodriver'))
    if cached:
        return str(cached[-1])
    raise ValueError('Provide an existing --geckodriver; this script does not install or download tools')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True, help='For example https://localhost:18443 or :19443')
    parser.add_argument('--credentials', required=True, help='Protected JSON/env file, or - for stdin')
    parser.add_argument('--node-name', required=True)
    parser.add_argument('--ssh-user', default='ztuser')
    parser.add_argument('--output-dir', required=True, type=Path)
    parser.add_argument('--geckodriver')
    parser.add_argument('--firefox', default=shutil.which('firefox'))
    parser.add_argument('--timeout', type=int, default=35)
    parser.add_argument('--mobile-frame-width', type=int, default=390,
                        help='Real same-origin iframe CSS viewport width, or 0 to skip (default 390)')
    args = parser.parse_args()
    url = urlsplit(args.base_url)
    if (url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in ('', '/')):
        parser.error('base-url must be an HTTP(S) origin without credentials/query/fragment')
    if not re.fullmatch(r'[A-Za-z0-9_-]{3,64}', args.node_name):
        parser.error('Invalid node name')
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,31}', args.ssh_user):
        parser.error('Invalid SSH account')
    if not 1 <= args.timeout <= 120:
        parser.error('timeout must be 1–120 seconds')
    if args.mobile_frame_width != 0 and not 320 <= args.mobile_frame_width <= 860:
        parser.error('mobile-frame-width must be 0 or 320–860 pixels')

    output = args.output_dir
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = output.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        parser.error('output-dir must be an owner-only directory owned by the current user')
    result_path = output / 'result.json'
    if result_path.exists():
        parser.error('Use a new output-dir to preserve the existing result.json')
    result = {
        'started_utc': datetime.now(timezone.utc).isoformat(),
        'base_url': args.base_url, 'node_name': args.node_name,
        'scope': 'Real browser/API/WebSocket/SSH; native WebSocket pass-through observer; no mocked transport/data',
        'checks': [], 'screenshots': [], 'ok': False,
        'not_tested': ['Internet firewall isolation', 'VM/Windows runtime', 'Telegram alerts',
                       'memory budget', 'server logout revocation of an open terminal (separate runtime check)'],
        'viewports': [], 'geometry': [], 'monitoring_data': [],
    }
    driver = None
    stage = 'credentials'

    def record(name, condition=True):
        result['checks'].append({'name': name, 'pass': bool(condition)})
        if not condition:
            raise AssertionError(name)

    def screenshot(name):
        # Never capture the login page or credential input fields.
        if driver.find_elements(By.ID, 'password'):
            return
        filename = name + '.png'
        if not driver.save_screenshot(str(output / filename)):
            raise RuntimeError('Cannot save screenshot')
        os.chmod(output / filename, 0o600)
        result['screenshots'].append(filename)

    try:
        login = credentials(args.credentials)
        from selenium import webdriver
        from selenium.webdriver.common.action_chains import ActionChains
        from selenium.webdriver.common.by import By
        from selenium.common.exceptions import StaleElementReferenceException
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.firefox.options import Options
        from selenium.webdriver.firefox.service import Service
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support.ui import Select

        stage = 'browser-startup'
        options = Options()
        options.add_argument('-headless')
        options.binary_location = args.firefox
        options.accept_insecure_certs = True
        options.set_preference('signon.rememberSignons', False)
        # Never let Selenium Manager download a driver, or driver logs record credentials.
        service = Service(driver_path(args.geckodriver), log_output=os.devnull)
        driver = webdriver.Firefox(options=options, service=service)
        driver.set_page_load_timeout(args.timeout)
        driver.set_script_timeout(args.timeout)
        driver.set_window_size(1600, 1000)
        result['browser'] = {'name': 'Firefox', 'version': driver.capabilities.get('browserVersion')}
        wait = WebDriverWait(driver, args.timeout, poll_frequency=0.2)

        def visible(selector):
            return wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, selector)))

        def heading(text):
            def current_heading(d):
                try:
                    return any(item.text == text for item in d.find_elements(By.TAG_NAME, 'h1'))
                except StaleElementReferenceException:
                    return False
            return wait.until(current_heading)

        def overview_loaded():
            heading('Tổng quan')
            visible('.workspace-overview')
            visible('.overview-resource-panel .resource-gauges svg[data-resource="cpu"]')
            visible('.overview-trend .metrics-chart svg[role="img"]')
            wait.until(lambda d: len(d.find_elements(By.CSS_SELECTOR,
                '.overview-heartbeat [data-heartbeat-bucket]')) == 30)

        def top_of_page():
            driver.execute_script("window.scrollTo({top: 0, left: 0, behavior: 'instant'})")
            wait.until(lambda d: d.execute_script('return window.scrollY <= 1'))

        def viewport_size():
            return driver.execute_script('''
              return {width: innerWidth, height: innerHeight,
                page: document.documentElement.scrollWidth,
                body: document.body.scrollWidth};
            ''')

        def gauge_geometry(label, scope):
            visible(scope + ' .resource-gauges')
            geometry = driver.execute_script('''
              const root = document.querySelector(arguments[0] + ' .resource-gauges');
              const rect = element => {
                const r = element.getBoundingClientRect();
                return {left: r.left, right: r.right, top: r.top,
                  bottom: r.bottom, width: r.width, height: r.height};
              };
              return {viewport: innerWidth, cards: [...root.querySelectorAll('.resource-gauge')]
                .map(card => ({...rect(card), resource: card.querySelector('svg[data-resource]')?.dataset.resource,
                  value: card.querySelector('.resource-gauge-value')
                    ? rect(card.querySelector('.resource-gauge-value')) : null}))};
            ''', scope)
            geometry.update({'name': label, 'scope': scope})
            result['geometry'].append(geometry)
            cards = geometry['cards']
            same = lambda values: max(values) - min(values) <= 1
            aligned = (len(cards) == 3 and {card['resource'] for card in cards} == {'cpu', 'ram', 'disk'}
                       and all(card['value'] for card in cards)
                       and all(same([card[key] for card in cards])
                               for key in ['top', 'height', 'width'])
                       and same([card['value']['bottom'] for card in cards]))
            record('Three gauge cards and numeric baselines align at ' + label, aligned)

        def overview_geometry(label):
            geometry = driver.execute_script('''
              const rect = element => {
                if (!element) return null;
                const r = element.getBoundingClientRect();
                return {left: r.left, right: r.right, top: r.top,
                  bottom: r.bottom, width: r.width, height: r.height};
              };
              const heading = document.querySelector('.workspace-page .page-heading');
              const panels = Object.fromEntries(['resource-panel', 'heartbeat', 'machines', 'trend']
                .map(name => [name, rect(document.querySelector('.overview-' + name))]));
              return {viewport: innerWidth, panels,
                heading: rect(heading?.querySelector('h1')),
                action: rect(heading?.querySelector('button')),
                summary: [...document.querySelectorAll('.summary-card')].map(rect)};
            ''')
            geometry['name'] = label
            result['geometry'].append(geometry)
            same = lambda values: bool(values) and max(values) - min(values) <= 1
            cards = geometry['summary']
            panels = geometry['panels']
            width = geometry['viewport']
            pairs = ([('resource-panel', 'heartbeat'), ('machines', 'trend')]
                     if width > 1200 else [('heartbeat', 'machines')] if width > 700 else [])
            pairs_align = all(panels[a] and panels[b]
                              and same([panels[a][edge], panels[b][edge]])
                              for a, b in pairs for edge in ['top', 'bottom'])
            mobile_align = (width > 700 or (all(panels.values())
                            and same([panel['left'] for panel in panels.values()])
                            and same([panel['right'] for panel in panels.values()])))
            action = geometry['action']
            title = geometry['heading']
            heading_align = bool(action and title and abs(
                (action['top'] + action['bottom']) / 2
                - (title['top'] + title['bottom']) / 2) <= 1)
            record('Overview panels, summary cards and heading action align at ' + label,
                   len(cards) == 4 and same([card['width'] for card in cards])
                   and same([card['height'] for card in cards])
                   and pairs_align and mobile_align and heading_align)

        def monitoring_data():
            observed = driver.execute_async_script('''
              const done = arguments[0];
              const gaugeRoot = document.querySelector('.overview-resource-panel .resource-gauges');
              const strip = document.querySelector('.overview-heartbeat .heartbeat-widget');
              const bars = strip?.querySelector('.heartbeat-bars');
              if (!gaugeRoot || !strip || !bars) return done({ok: false, reason: 'missing widgets'});
              const snapshot = {node: gaugeRoot.dataset.nodeId, sampleAt: gaugeRoot.dataset.sampleAt,
                values: [...gaugeRoot.querySelectorAll('svg[data-resource]')].map(svg => ({
                  resource: svg.dataset.resource,
                  value: Number(svg.querySelector('.resource-gauge-value')?.textContent.replace('%', '').trim())})),
                start: Number(bars.dataset.windowStart), end: Number(bars.dataset.windowEnd),
                buckets: [...strip.querySelectorAll('[data-heartbeat-bucket]')].map(bucket => ({
                  start: Number(bucket.dataset.start), end: Number(bucket.dataset.end),
                  count: Number(bucket.dataset.count), state: bucket.dataset.state}))};
              const headers = {Authorization: 'Bearer ' + localStorage.getItem('zt_session_token')};
              fetch('/api/nodes/' + encodeURIComponent(snapshot.node) + '/history', {headers})
                .then(async response => ({status: response.status, body: await response.json()}))
                .then(({status, body}) => {
                  const history = Array.isArray(body.data) ? body.data : [];
                  const sample = history.find(metric => Date.parse(metric.recorded_at) === Date.parse(snapshot.sampleAt));
                  const expected = sample ? {cpu: Number(sample.cpu_percent),
                    ram: Number(sample.memory_used_bytes) / Number(sample.memory_total_bytes) * 100,
                    disk: Number(sample.disk_used_bytes) / Number(sample.disk_total_bytes) * 100} : null;
                  const gaugesMatch = status === 200 && expected && snapshot.values.length === 3
                    && snapshot.values.every(value => Number.isFinite(value.value)
                      && value.value >= 0 && value.value <= 100
                      && Math.abs(value.value - expected[value.resource]) <= .051);
                  const timestamps = [...new Set(history.map(metric => Date.parse(metric.recorded_at)))]
                    .filter(Number.isFinite).sort((a, b) => a - b);
                  const buckets = snapshot.buckets;
                  const valid = buckets.length === 30 && snapshot.end - snapshot.start === 90000
                    && buckets.every((bucket, i) => Number.isInteger(bucket.count) && bucket.count >= 0
                      && bucket.start === snapshot.start + i * 3000 && bucket.end - bucket.start === 3000
                      && bucket.state === (bucket.count > 0 ? 'received' : 'missing'));
                  // Compare immutable historic buckets only. A new beacon may arrive
                  // between a React poll and this request, so exclude the live edge.
                  const lastReceivedStart = Math.max(...buckets.filter(bucket => bucket.count > 0).map(bucket => bucket.start));
                  const comparable = buckets.filter(bucket => bucket.start >= timestamps[0]
                    && bucket.end <= lastReceivedStart);
                  const countsMatch = comparable.every(bucket => bucket.count === timestamps
                    .filter(time => time >= bucket.start && time < bucket.end).length);
                  done({ok: status === 200, sample_at: snapshot.sampleAt,
                    gauges_match_api: Boolean(gaugesMatch), gauge_values: snapshot.values,
                    heartbeat_buckets_valid: valid, compared_history_buckets: comparable.length,
                    heartbeat_counts_match_api: countsMatch});
                }).catch(() => done({ok: false, reason: 'history request failed'}));
            ''')
            result['monitoring_data'].append(observed)
            record('Gauge values match the real history sample at their displayed timestamp',
                   observed.get('ok') and observed.get('gauges_match_api'))
            record('Heartbeat buckets match actual received samples without invented uptime',
                   observed.get('ok') and observed.get('heartbeat_buckets_valid')
                   and observed.get('compared_history_buckets', 0) >= 20
                   and observed.get('heartbeat_counts_match_api'))

        def fleet():
            wait.until(EC.element_to_be_clickable((By.XPATH, "//button[normalize-space()='Xem tất cả máy chủ']"))).click()
            heading('Máy chủ')
            visible('#server-fleet')

        def select_worker():
            select = '#server-fleet button[aria-label="Xem tài nguyên ' + args.node_name + '"]'
            wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, select))).click()
            visible('#worker-details[aria-label="Tài nguyên ' + args.node_name + '"]')
            wait.until(lambda d: d.find_element(By.CSS_SELECTOR, '#worker-details .status-badge').text == 'Online')

        def chart_loaded():
            visible('#worker-details .metrics-chart svg[role="img"]')
            wait.until(EC.invisibility_of_element_located((By.CSS_SELECTOR,
                '#worker-details .chart-loading[aria-busy="true"]')))

        def login_as(role):
            control = visible('#username')
            control.clear()
            control.send_keys(login[role + '_username'])
            control = driver.find_element(By.ID, 'password')
            control.clear()
            control.send_keys(login[role + '_password'])
            driver.find_element(By.CSS_SELECTOR, 'button[type="submit"]').click()
            overview_loaded()

        def logout():
            driver.find_element(By.CSS_SELECTOR, 'button[title="Đăng xuất khỏi hệ thống"]').click()
            visible('#username')
            return driver.execute_script("return localStorage.getItem('zt_session_token') === null")

        stage = 'admin-login'
        driver.get(args.base_url)
        visible('#username')
        driver.find_element(By.CSS_SELECTOR, 'button[aria-label="Hiện mật khẩu"]').click()
        shown = driver.find_element(By.ID, 'password').get_attribute('type') == 'text'
        driver.find_element(By.CSS_SELECTOR, 'button[aria-label="Ẩn mật khẩu"]').click()
        record('Password visibility toggle shows and hides the input', shown
               and driver.find_element(By.ID, 'password').get_attribute('type') == 'password')
        driver.execute_script(OBSERVE)
        login_as('admin')
        record('Overview has monitoring widgets without opening the Worker detail view',
               not driver.find_elements(By.ID, 'worker-details')
               and len(driver.find_elements(By.CSS_SELECTOR,
                   '.overview-resource-panel .resource-gauges svg[data-resource]')) == 3)
        gauge_geometry('overview-desktop', '.overview-resource-panel')
        overview_geometry('desktop')
        monitoring_data()
        screenshot('admin-overview')

        stage = 'theme-persistence'
        was_dark = driver.execute_script("return document.querySelector('.ops-app').classList.contains('dark')")
        theme_title = 'Chuyển sang giao diện sáng' if was_dark else 'Chuyển sang giao diện tối'
        driver.find_element(By.CSS_SELECTOR, 'button[title="' + theme_title + '"]').click()
        wait.until(lambda d: d.execute_script("return document.querySelector('.ops-app').classList.contains('dark')") != was_dark)
        screenshot('admin-overview-alternate-theme')
        driver.refresh()
        overview_loaded()
        record('Chosen light/dark theme survives a page reload',
               driver.execute_script("return document.querySelector('.ops-app').classList.contains('dark')") != was_dark)
        theme_title = 'Chuyển sang giao diện tối' if was_dark else 'Chuyển sang giao diện sáng'
        driver.find_element(By.CSS_SELECTOR, 'button[title="' + theme_title + '"]').click()
        driver.execute_script(OBSERVE)

        stage = 'overview-actions'
        updated = visible('.sync-strip time').get_attribute('datetime')
        driver.find_element(By.CSS_SELECTOR, 'button[aria-label="Làm mới"]').click()
        wait.until(lambda d: d.find_element(By.CSS_SELECTOR, '.sync-strip time').get_attribute('datetime') != updated)
        record('Overview refresh receives a new successful update timestamp')
        driver.find_element(By.CSS_SELECTOR, 'button[aria-label^="Lọc Offline:"]').click()
        heading('Máy chủ')
        record('Summary card filters the machine list',
               Select(visible('select[aria-label="Lọc trạng thái"]')).first_selected_option.get_attribute('value') == 'OFFLINE')
        driver.find_element(By.CSS_SELECTOR, 'button[aria-label^="Lọc Online:"]').click()
        select_worker()
        record('Online summary card restores the actual Worker',
               Select(visible('select[aria-label="Lọc trạng thái"]')).first_selected_option.get_attribute('value') == 'HEALTHY')
        driver.find_element(By.XPATH, "//nav//button[normalize-space()='Tổng quan']").click()
        overview_loaded()
        driver.find_element(By.CSS_SELECTOR, '.overview-worker-node').click()
        detail = visible('#worker-details')
        record('Overview machine button opens the real machine detail', args.node_name in detail.text)
        driver.find_element(By.XPATH, "//nav//button[normalize-space()='Tổng quan']").click()
        overview_loaded()

        stage = 'overview-responsive-layout'
        driver.set_window_size(768, 1024)
        top_of_page()
        overview_loaded()
        sizes = viewport_size()
        result['viewports'].append({'name': 'tablet-overview', **sizes})
        record('Overview fits the tablet viewport',
               max(sizes['page'], sizes['body']) <= sizes['width'] + 1)
        gauge_geometry('overview-tablet', '.overview-resource-panel')
        overview_geometry('tablet')
        screenshot('admin-overview-tablet')
        driver.set_window_size(1600, 1000)

        stage = 'fleet-navigation'
        fleet()
        select_worker()
        record('Fleet has its own machine table and selected Worker Online detail',
               bool(driver.find_elements(By.CSS_SELECTOR, '#server-fleet table')))
        scope = driver.find_element(By.ID, 'worker-metric-scope').text
        record('Resource source remains explicit without explanatory prose',
               'CPU / RAM / uptime' in scope and any(label in scope for label in
               ['Host Docker', 'Hệ điều hành máy ảo', 'Hệ điều hành Worker']))

        stage = 'fleet-filter-sort'
        search = visible('input[aria-label="Tìm máy chủ"]')
        search.send_keys('zt-ui-no-match-' + secrets.token_hex(8))
        wait.until(lambda d: not d.find_elements(By.CSS_SELECTOR,
            '#server-fleet button[aria-label^="Xem tài nguyên "]'))
        record('A search without matches hides unrelated Worker detail',
               not driver.find_elements(By.ID, 'worker-details'))
        search.clear()
        search.send_keys(args.node_name.upper())
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR,
            '#server-fleet button[aria-label="Xem tài nguyên ' + args.node_name + '"]')))
        record('Machine search is case-insensitive')
        search.clear()
        status = Select(visible('select[aria-label="Lọc trạng thái"]'))
        status.select_by_value('OFFLINE')
        wait.until(lambda d: not d.find_elements(By.CSS_SELECTOR,
            '#server-fleet button[aria-label="Xem tài nguyên ' + args.node_name + '"]'))
        record('Offline filter excludes the real Online Worker')
        status.select_by_value('ALL')
        sort = Select(visible('select[aria-label="Sắp xếp máy chủ"]'))
        sort.select_by_value('cpu')
        record('Fleet sort selection is usable', sort.first_selected_option.get_attribute('value') == 'cpu')
        select_worker()
        stage = 'telemetry-api'
        api = driver.execute_async_script('''
          const name = arguments[0], done = arguments[1];
          fetch('/api/nodes', {headers: {Authorization: 'Bearer ' + localStorage.getItem('zt_session_token')}})
            .then(async response => {
              const data = await response.json(), node = data.data?.find(item => item.name === name);
              done({status: response.status, online: node?.status === 'HEALTHY',
                metrics: node?.latest_metric?.memory_total_bytes > 0 && node?.latest_metric?.disk_total_bytes > 0});
            }).catch(() => done({status: 0}));
        ''', args.node_name)
        record('Real API returns current telemetry for selected Worker',
               api.get('status') == 200 and api.get('online') is True and api.get('metrics') is True)
        chart_loaded()
        record('Worker history has rendered a real timestamped CPU/RAM chart')
        screenshot('admin-dashboard')
        top_of_page()
        screenshot('admin-fleet-table')

        stage = 'responsive-layout'
        for label, width, height in [('desktop', 1600, 1000), ('tablet', 768, 1024), ('mobile-window', 390, 844)]:
            driver.set_window_size(width, height)
            top_of_page()
            sizes = viewport_size()
            # Firefox can enforce a minimum outer width: record the actual viewport.
            result['viewports'].append({'name': label, **sizes})
            record('No page overflow at ' + label + ' actual width ' + str(sizes['width']),
                   max(sizes['page'], sizes['body']) <= sizes['width'] + 1)
            gauge_geometry('fleet-' + label, '#worker-details')
            screenshot('admin-fleet-' + label)
        driver.set_window_size(1600, 1000)

        if args.mobile_frame_width:
            stage = 'responsive-mobile-frame'
            # A same-origin iframe provides a real CSS viewport below Firefox's
            # minimum outer window width, using the same app, API and login.
            # It is not a physical-device/browser emulation or mocked transport.
            frame = driver.execute_script('''
              const frame = document.createElement('iframe');
              frame.id = 'zt-browser-mobile-viewport'; frame.title = 'Dashboard CSS viewport verification';
              Object.assign(frame.style, {position: 'fixed', left: '0', top: '0',
                width: arguments[0] + 'px', height: '844px', border: '0', zIndex: '2147483647'});
              frame.src = arguments[1]; document.body.append(frame); return frame;
            ''', args.mobile_frame_width, args.base_url)
            try:
                wait.until(EC.frame_to_be_available_and_switch_to_it(frame))
                overview_loaded()
                sizes = viewport_size()
                result['viewports'].append({'name': 'mobile-iframe-overview', 'sizing': 'same-origin iframe CSS viewport', **sizes})
                record('Overview fits the actual mobile iframe CSS viewport',
                       sizes['width'] == args.mobile_frame_width
                       and max(sizes['page'], sizes['body']) <= sizes['width'] + 1)
                gauge_geometry('overview-mobile-iframe', '.overview-resource-panel')
                overview_geometry('mobile-iframe')
                driver.switch_to.default_content()
                filename = 'admin-overview-mobile-' + str(args.mobile_frame_width) + '.png'
                if not frame.screenshot(str(output / filename)):
                    raise RuntimeError('Cannot save mobile overview screenshot')
                os.chmod(output / filename, 0o600)
                result['screenshots'].append(filename)
                driver.switch_to.frame(frame)
                driver.find_element(By.CSS_SELECTOR, '.menu-trigger').click()
                visible('.sidebar.is-open')
                ActionChains(driver).send_keys(Keys.ESCAPE).perform()
                wait.until(EC.invisibility_of_element_located((By.CSS_SELECTOR, '.sidebar.is-open')))
                driver.find_element(By.CSS_SELECTOR, '.menu-trigger').click()
                visible('.sidebar.is-open')
                driver.find_element(By.XPATH, "//nav//button[normalize-space()='Máy chủ']").click()
                heading('Máy chủ')
                record('Mobile menu opens, closes with Escape and navigates to Fleet')
                select_worker()
                chart_loaded()
                sizes = viewport_size()
                result['viewports'].append({'name': 'mobile-iframe-fleet', 'sizing': 'same-origin iframe CSS viewport', **sizes})
                record('Fleet and Worker detail fit the actual mobile iframe CSS viewport',
                       sizes['width'] == args.mobile_frame_width
                       and max(sizes['page'], sizes['body']) <= sizes['width'] + 1)
                gauge_geometry('fleet-mobile-iframe', '#worker-details')
                top_of_page()
                driver.switch_to.default_content()
                filename = 'admin-fleet-mobile-' + str(args.mobile_frame_width) + '.png'
                if not frame.screenshot(str(output / filename)):
                    raise RuntimeError('Cannot save mobile fleet screenshot')
                os.chmod(output / filename, 0o600)
                result['screenshots'].append(filename)
            finally:
                driver.switch_to.default_content()
                driver.execute_script('arguments[0].remove()', frame)

        stage = 'terminal-connect'
        panel = driver.find_element(By.CSS_SELECTOR, '.detail-panel')
        # Activate the real button by keyboard; avoid a pointer race when the
        # removed mobile iframe has just changed the parent scroll position.
        panel.find_element(By.XPATH, ".//button[normalize-space()='Mở Web SSH']").send_keys(Keys.ENTER)
        visible('[role="dialog"]')
        record('Admin opens Web SSH using the keyboard')
        wait.until(lambda d: d.execute_script('return window.ztEc2Browser.sockets.at(-1)?.ready === true'))
        record('Browser WebSocket reaches real Worker SSH',
               driver.execute_script('return window.ztEc2Browser.sockets.at(-1)?.user') == args.ssh_user)
        driver.find_element(By.CSS_SELECTOR, 'button[aria-label="Phóng to Terminal"]').click()
        visible('button[aria-label="Thu nhỏ Terminal"]')
        driver.find_element(By.CSS_SELECTOR, 'button[aria-label="Thu nhỏ Terminal"]').click()
        record('Terminal fullscreen control expands and restores the dialog',
               bool(driver.find_elements(By.CSS_SELECTOR, 'button[aria-label="Phóng to Terminal"]')))
        stage = 'terminal-command'
        marker = 'ZT_EC2_BROWSER_' + secrets.token_hex(8).upper()
        text = 'Kiểm chứng SSH • tiếng Việt ✓'
        encoded = base64.b64encode(('\n' + text + '\n' + marker + '\n').encode()).decode()
        command = "whoami; printf '%s' '" + encoded + "' | base64 -d"
        textarea = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, '.xterm-helper-textarea')))
        driver.execute_script('arguments[0].focus()', textarea)
        ActionChains(driver).send_keys(command).send_keys(Keys.ENTER).perform()
        wait.until(lambda d: d.execute_script(
            'return window.ztEc2Browser.sockets.at(-1)?.output.includes(arguments[0])', marker))
        observed = driver.execute_script('return window.ztEc2Browser.sockets.at(-1)')
        rendered = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', observed['output']).replace('\r', '')
        record('SSH command returns generated marker, expected user and Unicode',
               marker in rendered and text in rendered and args.ssh_user in rendered.splitlines()
               and observed.get('error') is False)
        screenshot('admin-terminal')
        stage = 'terminal-reconnect'
        ActionChains(driver).send_keys('exit').send_keys(Keys.ENTER).perform()
        wait.until(lambda d: d.execute_script('return window.ztEc2Browser.sockets.at(-1)?.closed === true'))
        socket_count = driver.execute_script('return window.ztEc2Browser.sockets.length')
        wait.until(EC.element_to_be_clickable((By.XPATH, "//button[normalize-space()='Mở phiên mới']"))).click()
        wait.until(lambda d: d.execute_script('return window.ztEc2Browser.sockets.length > arguments[0] && window.ztEc2Browser.sockets.at(-1)?.ready === true', socket_count))
        record('Opening a new terminal session reconnects to real SSH after exit')
        stage = 'terminal-close'
        driver.find_element(By.CSS_SELECTOR, 'button[aria-label="Đóng Terminal"]').click()
        wait.until(EC.invisibility_of_element_located((By.CSS_SELECTOR, '[role="dialog"]')))
        wait.until(lambda d: d.execute_script('return window.ztEc2Browser.sockets.at(-1)?.closed === true'))
        record('Closing terminal dialog closes the real WebSocket')

        stage = 'admin-audit'
        driver.find_element(By.XPATH, "//nav//button[normalize-space()='Nhật ký hoạt động']").click()
        visible('.audit-table tbody tr')
        record('Admin audit view reads real recorded events')
        visible('.audit-details summary').click()
        record('Audit details expand and show the raw event code',
               bool(driver.find_elements(By.CSS_SELECTOR, '.audit-details[open]'))
               and 'Mã sự kiện' in driver.find_element(By.CSS_SELECTOR, '.audit-details[open]').text)
        Select(visible('#audit-event')).select_by_value('BASTION_SESSION_START')
        driver.find_element(By.CSS_SELECTOR, '.audit-filters button[type="submit"]').click()
        wait.until(lambda d: d.find_element(By.CSS_SELECTOR, '.audit-results').get_attribute('aria-busy') == 'false')
        record('Audit event filter applies to real recorded events',
               all('Mở phiên SSH' in row.text for row in driver.find_elements(By.CSS_SELECTOR, '.audit-table tbody tr'))
               and bool(driver.find_elements(By.CSS_SELECTOR, '.audit-table tbody tr')))
        driver.find_element(By.ID, 'audit-search').send_keys('zt-audit-no-match-' + secrets.token_hex(8))
        driver.find_element(By.CSS_SELECTOR, '.audit-filters button[type="submit"]').click()
        wait.until(EC.text_to_be_present_in_element((By.CSS_SELECTOR, '.audit-results'), 'Không có sự kiện phù hợp'))
        visible('button[aria-label="Xóa bộ lọc"]').click()
        visible('.audit-table tbody tr')
        record('Audit search and reset return from empty results to real events',
               driver.find_element(By.ID, 'audit-search').get_attribute('value') == ''
               and Select(driver.find_element(By.ID, 'audit-event')).first_selected_option.get_attribute('value') == '')
        next_page = driver.find_element(By.CSS_SELECTOR, 'button[aria-label="Trang sau"]')
        if next_page.is_enabled():
            next_page.click()
            wait.until(EC.text_to_be_present_in_element((By.CSS_SELECTOR, '.audit-pagination > span'), '2'))
            wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, 'button[aria-label="Trang trước"]'))).click()
            wait.until(EC.text_to_be_present_in_element((By.CSS_SELECTOR, '.audit-pagination > span'), '1'))
            visible('.audit-table tbody tr')
            record('Audit pagination moves forward and back')
        else:
            result['not_tested'].append('Audit pagination beyond page one: actual dataset has one page')
        screenshot('admin-audit')
        stage = 'admin-logout'
        record('Admin UI logout clears browser session', logout())
        stage = 'viewer-login'
        login_as('viewer')
        fleet()
        select_worker()
        stage = 'viewer-permissions'
        record('Viewer sees selected Worker Online without SSH or admin-audit controls',
               not driver.find_elements(By.CSS_SELECTOR, '.node-ssh, .detail-panel button')
               and not driver.find_elements(By.XPATH, "//nav//button[normalize-space()='Nhật ký hoạt động']")
               and bool(driver.find_elements(By.CSS_SELECTOR, '.viewer-label, .read-only-label')))
        denied = driver.execute_async_script('''
          const name = arguments[0], done = arguments[1];
          const headers = {Authorization: 'Bearer ' + localStorage.getItem('zt_session_token'), 'Content-Type': 'application/json'};
          fetch('/api/nodes', {headers}).then(response => response.json()).then(data => {
            const node = data.data?.find(item => item.name === name);
            if (!node) return done(0);
            fetch('/api/bastion/ticket', {method: 'POST', headers, body: JSON.stringify({node_id: node.id})})
              .then(response => done(response.status)).catch(() => done(0));
          }).catch(() => done(0));
        ''', args.node_name)
        record('Real API denies Viewer an SSH ticket', denied == 403)
        screenshot('viewer-dashboard')
        stage = 'viewer-logout'
        record('Viewer UI logout clears browser session', logout())
        stage = 'browser-errors'
        record('No observed browser errors after observer installation',
               driver.execute_script('return window.ztEc2Browser.errors') == 0)
        result['ok'] = True
    except Exception as error:
        # Exception text / browser HTML can contain credentials; record only type/stage.
        result['error_class'] = type(error).__name__
        result['error_stage'] = stage
        if driver is not None:
            try:
                screenshot('failure')
            except Exception:
                pass
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass
        result['completed_utc'] = datetime.now(timezone.utc).isoformat()
        result['passed'] = sum(item['pass'] for item in result['checks'])
        fd = os.open(result_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        print(json.dumps(result, ensure_ascii=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
