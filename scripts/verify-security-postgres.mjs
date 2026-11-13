import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {postgresOptions} from '../lib/hosted.mjs';
import {securityScenarios} from '../tests/helpers/security-scenarios.mjs';

// Deliberately separate from DATABASE_URL: require an explicitly chosen test DB.
if(!process.env.SECURITY_TEST_DATABASE_URL)throw new Error('Set SECURITY_TEST_DATABASE_URL to a PostgreSQL test database.');
const options=postgresOptions({...process.env,DATABASE_URL:process.env.SECURITY_TEST_DATABASE_URL});
const admin=new Pool(options),schema=`commerce_security_test_${randomBytes(8).toString('hex')}`;
let pool,created=false;
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);created=true;
  pool=new Pool({...options,options:`-c search_path=${schema}`});
  console.log(JSON.stringify({postgresIntegration:await securityScenarios(pool)}));
} catch {
  console.error('PostgreSQL security checks failed. Database credentials are not printed.');process.exitCode=1;
} finally {
  await pool?.end();
  if(created){
    if(!/^commerce_security_test_[a-f0-9]{16}$/.test(schema))throw new Error('Unexpected test schema.');
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
  await admin.end();
}

