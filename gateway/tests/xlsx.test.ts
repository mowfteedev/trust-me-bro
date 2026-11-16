import { describe, expect, it } from 'vitest';
import { createSpreadsheet, exportTimestamp, ExportLimitError, MAX_EXPORT_ROWS } from '../src/utils/xlsx.js';
import { spreadsheetParts } from './helpers/xlsx.js';

describe('real XLSX serialization', () => {
  it('creates an OPC ZIP package with valid workbook/worksheet relationships', () => {
    const file = createSpreadsheet(['Tiếng Việt'], [['máy chủ ✓']], 'Nhật ký');
    expect(file.subarray(0, 2).toString()).toBe('PK');
    const parts = spreadsheetParts(file);
    expect(Object.keys(parts).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels',
      'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    expect(parts['xl/workbook.xml']).toContain('sheet name="Nhật ký"');
    expect(parts['xl/_rels/workbook.xml.rels']).toContain('Target="worksheets/sheet1.xml"');
    expect(parts['xl/worksheets/sheet1.xml']).toContain('máy chủ ✓');
  });
  it('always emits formulas and hyperlink-looking inputs as literal inline strings', () => {
    const values = ['=HYPERLINK("https://example.com", "click")', '+SUM(1,2)', '-1+2', '@SUM(A1)', '=1+1'];
    const worksheet = spreadsheetParts(createSpreadsheet(['Dữ liệu'], values.map(value => [value]), 'Literal'))['xl/worksheets/sheet1.xml'];
    expect(worksheet).not.toContain('<f');
    expect(worksheet).not.toContain('<hyperlink');
    expect(worksheet.match(/t="inlineStr"/g)).toHaveLength(values.length + 1);
    expect(worksheet).toContain('=HYPERLINK(&quot;https://example.com&quot;, &quot;click&quot;)');
  });
  it('keeps finite numbers and booleans typed, and preserves whitespace/Unicode/XML characters', () => {
    const sheet = spreadsheetParts(createSpreadsheet(['A', 'B', 'C', 'D'], [[12.5, true, null, ' <&>\r\n🙂 _x000A_\u0000'] ], 'Types'))['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('<c r="A2" t="n"><v>12.5</v></c>');
    expect(sheet).toContain('<c r="B2" t="b"><v>1</v></c>');
    expect(sheet).toContain(' &lt;&amp;&gt;&#13;\n🙂 _x005F_x000A_\ufffd');
    expect(sheet).not.toContain('\u0000');
  });
  it('exports an empty filtered result as a header-only workbook', () => {
    const sheet = spreadsheetParts(createSpreadsheet(['ID'], [], 'Empty'))['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('dimension ref="A1:A1"');
    expect(sheet.match(/<row /g)).toHaveLength(1);
  });
  it('rejects row overflow and excessive cell/package size rather than silently truncating', () => {
    expect(() => createSpreadsheet(['ID'], Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => ['value']), 'Rows')).toThrow(ExportLimitError);
    expect(() => createSpreadsheet(['Value'], [['v'.repeat(32768)]], 'Cell')).toThrow(ExportLimitError);
    expect(() => createSpreadsheet(['Value'], Array.from({ length: 300 }, () => ['v'.repeat(32760)]), 'Bytes')).toThrow(ExportLimitError);
  });
  it('uses explicit Vietnam time regardless of server timezone', () => {
    const timestamp = exportTimestamp('2026-11-17T00:00:00.000Z');
    expect(timestamp).toContain('07:00:00'); expect(timestamp).toContain('17/11/2026');
    expect(exportTimestamp(null)).toBe(''); expect(exportTimestamp('invalid')).toBe('');
  });
});
