// Standalone CI/acceptance entry point; injected execution below remains supported.
if (typeof credentials === 'undefined') {
 const f=require('node:fs'),p=require('node:path'),o=require('node:os'),c=require('node:crypto');
 const {spawnSync:spawn}=require('node:child_process');
 const root=p.resolve(__dirname,'..'),temp=f.mkdtempSync(p.join(o.tmpdir(),'zt-enrollment-driver-'));
 f.chmodSync(temp,0o700);
 const name='zt-enrollment-lab-'+c.randomBytes(6).toString('hex'),owner=c.randomBytes(24).toString('hex'),app=c.randomBytes(24).toString('hex');
 const file=p.join(temp,'postgres.env');f.writeFileSync(file,`POSTGRES_USER=zt_admin\nPOSTGRES_PASSWORD=${owner}\nPOSTGRES_DB=zt_serverops\n`,{mode:0o600});
 const docker=(args,input)=>{const r=spawn('docker',args,{input,encoding:'utf8',timeout:45000});if(r.status!==0)throw Error('Isolated enrollment Docker command failed');return r.stdout.trim()};
 let code=1;
 try {
  docker(['run','-d','--name',name,'--memory','256m','--env-file',file,'-p','127.0.0.1::5432','postgres:16-alpine']);
  const end=Date.now()+30000;
  while(spawn('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','zt_admin'],{stdio:'ignore'}).status!==0){if(Date.now()>end)throw Error('PG readiness timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150)}
  docker(['exec','-i',name,'psql','-Xq','-v','ON_ERROR_STOP=1','-U','zt_admin','-d','zt_serverops'],`CREATE ROLE zt_app LOGIN PASSWORD '${app}'; CREATE ROLE zt_maintenance NOLOGIN;`);
  const port=docker(['port',name,'5432/tcp']).split(':').at(-1);
  const data={migration_url:`postgresql://zt_admin:${owner}@127.0.0.1:${port}/zt_serverops`,app_url:`postgresql://zt_app:${app}@127.0.0.1:${port}/zt_serverops`};
  const r=spawn(process.execPath,['-'],{cwd:p.join(root,'gateway'),input:'const credentials='+JSON.stringify(data)+';\n'+f.readFileSync(__filename,'utf8'),encoding:'utf8',timeout:150000});
  process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');code=r.status===0?0:1;
 } catch {console.error('Enrollment lab setup failed; no production resources used.');}
 finally {const r=spawn('docker',['rm','-f','-v',name],{stdio:'ignore'});if(r.status!==0)code=1;f.rmSync(temp,{recursive:true,force:true});}
 process.exit(code);
}
// Actual PostgreSQL, local admin CLI and Fastify route; no production DB/Telegram.
// Prefix `const credentials={migration_url,app_url};` through stdin like the other labs.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {Pool}=require('pg');
const database='zt_enrollment_'+crypto.randomBytes(6).toString('hex');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'zt-enrollment-runtime-'));
fs.chmodSync(directory,0o700);
const admin=new Pool({connectionString:credentials.migration_url,connectionTimeoutMillis:3000});
let created=false,db,app,server,closePool,config;
const checks=[];
const check=name=>{checks.push(name);console.log('PASS enrollment: '+name)};
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const makeHost=()=>{
 const pair=crypto.generateKeyPairSync('ed25519');
 const raw=pair.publicKey.export({format:'der',type:'spki'}).subarray(-32);
 return'ssh-ed25519 '+Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020','hex'),raw]).toString('base64');
};
const host=makeHost();
const makeClaim=id=>({invitation_id:id,wireguard_public_key:crypto.randomBytes(32).toString('base64'),
 ssh_host_public_key:makeHost(),node_token:crypto.randomBytes(32).toString('hex')});
let serial=0;
let requestCount=0;
async function main(){
 await admin.query(`CREATE DATABASE ${database}`);created=true;
 const migration=new URL(credentials.migration_url),runtime=new URL(credentials.app_url);
 migration.pathname=runtime.pathname='/'+database;
 process.env.MIGRATION_DATABASE_URL=migration.toString();process.env.DATABASE_URL=runtime.toString();
 process.env.NODE_ENV='test';process.env.TELEGRAM_MODE='disabled';
 process.env.JWT_SECRET=crypto.randomBytes(32).toString('hex');
 process.env.ENROLLMENT_ENABLED='true';process.env.ENROLLMENT_PUBLIC_URL='https://gateway.example.test';
 process.env.ENROLLMENT_ENDPOINT='192.0.2.10:51820';
 process.env.ENROLLMENT_GATEWAY_PUBLIC_KEY=crypto.randomBytes(32).toString('base64');
 process.env.ENROLLMENT_BASTION_PUBLIC_KEY=host;
 process.env.ENROLLMENT_REQUEST_DIR=path.join(directory,'requests');process.env.ENROLLMENT_ACK_DIR=path.join(directory,'acks');
 fs.mkdirSync(process.env.ENROLLMENT_REQUEST_DIR,{mode:0o700});fs.mkdirSync(process.env.ENROLLMENT_ACK_DIR,{mode:0o755});
 await require('./dist/services/migration-runner.js').runMigrations();
 db=new Pool({connectionString:migration.toString(),connectionTimeoutMillis:3000});
 app=new Pool({connectionString:runtime.toString(),connectionTimeoutMillis:3000});
 ({config}=require('./dist/config/env.js'));({closeDatabasePool:closePool}=require('./dist/services/db.js'));
 server=await require('./dist/app.js').buildServer();
 const metadata=require('./dist/services/enrollment-contract.js').enrollmentPublicConfig(process.env);
 const cli=(action,input)=>spawnSync(process.execPath,['dist/scripts/enrollment.js',action],{
   env:{...process.env,DATABASE_URL:migration.toString()},input:JSON.stringify(input),encoding:'utf8',timeout:15000});
 const issue=(overrides={})=>{
  const input={node_name:'enrollment-'+(++serial),worker_os:'linux',...overrides};
  const r=cli('issue',input);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
 };
 const send=(invite,body,token=invite.join_token)=>server.inject({method:'POST',url:'/api/enrollment/claim',remoteAddress:'198.51.100.'+(1+(requestCount++%200)),
  headers:{'x-enrollment-token':token},payload:body});
 const ack=(invite,body,ip)=>fs.writeFileSync(path.join(process.env.ENROLLMENT_ACK_DIR,invite.invitation_id+'.ready'),
  body.wireguard_public_key+'\n'+ip+'\n',{mode:0o644});

 const migrationsDir = [path.resolve(process.cwd(), 'migrations'), path.resolve(process.cwd(), 'gateway/migrations')].find(d => fs.existsSync(d));
 const expectedMigrationCount = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).length;
 assert.equal((await db.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, expectedMigrationCount);
 assert.equal((await app.query('SELECT current_user')).rows[0].current_user,'zt_app');
 await assert.rejects(app.query('SELECT * FROM worker_enrollments'),/permission denied/);
 await assert.rejects(app.query("INSERT INTO worker_enrollments(gateway_id,token_hash,node_name,node_ip,node_type,worker_os,ssh_username,expires_at)VALUES('x','x','bad','10.100.0.3','VM','linux','ztuser',now())"),/permission denied/);
 assert.equal((await db.query("SELECT has_function_privilege('zt_maintenance','claim_worker_enrollment(uuid,text,text,text,text,text,text,text)','execute') AS allowed")).rows[0].allowed,false);
 assert.equal((await db.query("SELECT NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE p.oid='public.claim_worker_enrollment(uuid,text,text,text,text,text,text,text)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS denied")).rows[0].denied,true);
 check(expectedMigrationCount + ' migrations, app authenticated, invitation table private and capability not public');

 const a=issue(),body=makeClaim(a.invitation_id);
 assert.deepEqual(Object.keys(a).sort(),['version','gateway_id','registration_url','wireguard_endpoint',
  'wireguard_public_key','gateway_vpn_ip','bastion_public_key','invitation_id','join_token','expires_at',
  'node_name','node_type','worker_os','ssh_username'].sort());
 for(const ssh_username of ['root','admin','administrator','Administrator','bad.user','a'.repeat(21)]){
  assert.notEqual(cli('issue',{node_name:'reject-user',worker_os:'linux',ssh_username}).status,0);
 }
 assert.equal(a.version,1);assert.equal(a.gateway_id,metadata.gateway_id);assert.equal(a.registration_url,metadata.registration_url);
 assert.equal((await send(a,body,'0'.repeat(64))).statusCode,401);
 assert.equal((await send(a,{...body,node_ip:'192.0.2.99'})).statusCode,400);
 assert.equal((await db.query('SELECT count(*)::int n FROM nodes')).rows[0].n,0);
 check('wrong code and client-chosen assignment rejected before node creation');

 const r=await send(a,body);assert.equal(r.statusCode,202,r.body);
 const first=r.json();assert.equal(first.node_name,a.node_name);assert.equal(first.status,'PENDING');
 assert.deepEqual(first.verification,{peer_applied:false,heartbeat_recent:false,ssh_authenticated:false});
 const stored=(await db.query('SELECT * FROM worker_enrollments WHERE id=$1',[a.invitation_id])).rows[0];
 assert.equal(stored.token_hash,hash(a.join_token));assert(stored.consumed_at);
 assert(!JSON.stringify(stored).includes(a.join_token));assert(!JSON.stringify(stored).includes(body.node_token));
 const node=(await db.query('SELECT * FROM nodes WHERE id=$1',[first.node_id])).rows[0];
 assert.equal(node.token_hash,hash(body.node_token));assert.equal(node.status,'OFFLINE');assert.equal(node.last_seen,null);
 assert.equal(node.ssh_username,'ztuser');
 const content=fs.readFileSync(path.join(process.env.ENROLLMENT_REQUEST_DIR,a.invitation_id+'.peer'),'utf8');
 assert.equal(content,body.wireguard_public_key+'\n'+first.node_ip+'\n');
 assert(!content.includes(body.node_token));assert(!content.includes(a.join_token));
 check('real API consumes hash capability atomically; pending node has no false Offline incident or secret handoff');

 ack(a,body,first.node_ip);
 const concurrent=await Promise.all(Array.from({length:8},()=>send(a,body)));
 assert(concurrent.every(x=>x.statusCode===200),concurrent.map(x=>x.body).join('\n'));
 assert(concurrent.every(x=>x.json().node_id===first.node_id));
 assert.equal((await db.query('SELECT count(*)::int n FROM nodes WHERE id=$1',[first.node_id])).rows[0].n,1);
 assert.equal((await db.query("SELECT count(*)::int n FROM audit_logs WHERE action='WORKER_ENROLLED' AND node_id=$1",[first.node_id])).rows[0].n,1);
 assert.equal((await send(a,{...body,node_token:crypto.randomBytes(32).toString('hex')})).statusCode,409);
 assert.equal((await send(a,{...body,ssh_host_public_key:makeHost()})).statusCode,409);
 assert.equal((await send(a,{...body,wireguard_public_key:crypto.randomBytes(32).toString('base64')})).statusCode,409);
 check('eight concurrent retries preserve one node/audit; consumed code cannot change keys or token');

 await db.query("UPDATE worker_enrollments SET created_at=now()-interval'1 hour',expires_at=now()-interval'1 minute'WHERE id=$1",[a.invitation_id]);
 assert.equal((await send(a,body)).statusCode,200,'An exact retry after response loss survives expiry');
 const expired=issue(),expiredBody=makeClaim(expired.invitation_id);
 await db.query("UPDATE worker_enrollments SET created_at=now()-interval'1 hour',expires_at=now()-interval'1 minute'WHERE id=$1",[expired.invitation_id]);
 assert.equal((await send(expired,expiredBody)).statusCode,410);
 const revoked=issue(),revokedBody=makeClaim(revoked.invitation_id);
 const revoke=cli('revoke',{invitation_id:revoked.invitation_id});assert.equal(revoke.status,0);
 assert.equal((await send(revoked,revokedBody)).statusCode,410);
 assert.equal(cli('revoke',{invitation_id:revoked.invitation_id}).status,0);
 check('unconsumed expired/revoked code denied; exact consumed replay recovers a lost response');

 const b=issue(),bodyB=makeClaim(b.invitation_id);
 const attempts=await Promise.all([send(b,bodyB),send(b,{...bodyB,node_token:crypto.randomBytes(32).toString('hex')})]);
 assert.deepEqual(attempts.map(x=>x.statusCode).sort(),[202,409]);
 assert.equal((await db.query('SELECT count(*)::int n FROM nodes WHERE name=$1',[b.node_name])).rows[0].n,1);
 check('concurrent different claim has exactly one winner');

 const failed=issue(),failedBody=makeClaim(failed.invitation_id);
 const originalRequests=config.ENROLLMENT_REQUEST_DIR;
 config.ENROLLMENT_REQUEST_DIR=path.join(directory,'missing');
 assert.equal((await send(failed,failedBody)).statusCode,503);
 config.ENROLLMENT_REQUEST_DIR=originalRequests;
 const retried=await send(failed,failedBody);assert.equal(retried.statusCode,202,retried.body);
 assert.equal((await db.query('SELECT count(*)::int n FROM nodes WHERE name=$1',[failed.node_name])).rows[0].n,1);
 assert.equal((await db.query("SELECT count(*)::int n FROM audit_logs WHERE target=$1 AND action='WORKER_ENROLLED'",[failed.node_name])).rows[0].n,1);
 check('database commit plus interrupted file handoff resumes without a duplicate identity');

 const unique=issue({node_ip:'10.100.0.100'});
 assert.notEqual(cli('issue',{node_name:unique.node_name,worker_os:'windows'}).status,0);
 assert.notEqual(cli('issue',{node_name:'different-address-owner',node_ip:'10.100.0.100',worker_os:'linux'}).status,0);
 const changedGateway=config.ENROLLMENT_GATEWAY_ID;
 config.ENROLLMENT_GATEWAY_ID='sha256:'+'0'.repeat(64);
 assert.equal((await send(unique,makeClaim(unique.invitation_id))).statusCode,503);
 config.ENROLLMENT_GATEWAY_ID=changedGateway;
 const status=cli('status',{invitation_id:a.invitation_id,node_name:a.node_name});assert.equal(status.status,0);
 const report=JSON.parse(status.stdout);assert.equal(report.active_admins,0);assert.equal(report.invitation.consumed,true);
 assert.equal(report.node.name,a.node_name);assert(!status.stdout.includes(a.join_token));
 check('local CLI reserves names/IPs, refuses invalid Gateway binding and reports public status only');

 await db.query('UPDATE nodes SET is_token_revoked=true WHERE id=$1',[first.node_id]);
 assert.equal((await send(a,body)).statusCode,409);
 assert.equal((await db.query('SELECT count(*)::int n FROM alerts')).rows[0].n,0);
 check('revoked node cannot regain enrollment and test creates no alert/Telegram noise');

 const {hashPassword,verifyPassword}=require('./dist/utils/crypto.js');
 const bootstrap=(input,args=['--stdin'])=>spawnSync(process.execPath,[path.resolve('dist/scripts/bootstrap-admin.js'),...args],{
  cwd:directory,env:{...process.env,DATABASE_URL:migration.toString()},input:JSON.stringify(input),encoding:'utf8',timeout:15000});
 const viewerHash=hashPassword('viewer-private-test-password');
 await db.query("INSERT INTO users(username,password_hash,role)VALUES('bootstrap-collision',$1,'VIEWER')",[viewerHash]);
 assert.equal(bootstrap({username:'bootstrap-collision',password:'unwanted-admin-password'}).status,0);
 const keptViewer=(await db.query("SELECT role,password_hash FROM users WHERE username='bootstrap-collision'")).rows[0];
 assert.equal(keptViewer.role,'VIEWER');assert.equal(keptViewer.password_hash,viewerHash);
 const firstPassword=crypto.randomBytes(24).toString('hex');
 const firstAdmin=bootstrap({username:'first-admin',password:firstPassword});assert.equal(firstAdmin.status,0,firstAdmin.stderr);
 assert.equal(JSON.parse(firstAdmin.stdout).created,true);
 const beforeAdmin=(await db.query("SELECT * FROM users WHERE username='first-admin'")).rows[0];
 assert(verifyPassword(firstPassword,beforeAdmin.password_hash));
 assert(!JSON.stringify(beforeAdmin).includes(firstPassword));assert(!firstAdmin.stdout.includes(firstPassword));
 const changed='changed-private-password-'+crypto.randomBytes(8).toString('hex');
 await db.query("UPDATE users SET password_hash=$1,session_version=session_version+2 WHERE username='first-admin'",[hashPassword(changed)]);
 const changedRow=(await db.query("SELECT * FROM users WHERE username='first-admin'")).rows[0];
 const rerun=bootstrap({username:'first-admin',password:firstPassword});assert.equal(rerun.status,0);
 assert.equal(JSON.parse(rerun.stdout).created,false);
 assert.deepEqual((await db.query("SELECT * FROM users WHERE username='first-admin'")).rows[0],changedRow);
 assert(verifyPassword(changed,changedRow.password_hash));assert(!verifyPassword(firstPassword,changedRow.password_hash));
 assert.equal(bootstrap({username:'another-admin',password:firstPassword}).status,0);
 assert.equal((await db.query("SELECT count(*)::int n FROM users WHERE role='ADMIN'")).rows[0].n,1);
 check('secure Admin bootstrap preserves changed passwords/session versions and never promotes an existing Viewer');

 for(const [input,args]of [[{username:'bad',password:'short'},['--stdin']],
  [{username:'bad',password:firstPassword,extra:'unexpected'},['--stdin']],
  [{username:'bad',password:firstPassword},['--password','test-sensitive-argv-value']]]){
  const denied=bootstrap(input,args);assert.notEqual(denied.status,0);
  assert(!denied.stderr.includes(firstPassword));assert(!denied.stderr.includes('test-sensitive-argv-value'));
 }
 assert(!fs.existsSync(path.join(directory,'keys')));assert(!fs.existsSync(path.join(directory,'demo-login.env')));
 check('bootstrap rejects malformed/password-argv input and writes no plaintext credential files');
 console.log('Enrollment runtime checks PASS: '+checks.length);
}
main().catch(error=>{console.error('FAIL enrollment runtime:',error.message);process.exitCode=1}).finally(async()=>{
 if(server)await server.close();if(closePool)await closePool();if(app)await app.end();if(db)await db.end();
 if(created)await admin.query(`DROP DATABASE ${database} WITH(FORCE)`);await admin.end();
 fs.rmSync(directory,{recursive:true,force:true});
});
