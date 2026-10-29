'use strict';
const fs=require('node:fs'); const path=require('node:path'); const pool=require('../db');
async function migrate(){const c=await pool.connect();try{await c.query('BEGIN');await c.query(fs.readFileSync(path.join(__dirname,'project_scheduling.sql'),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function rollback(){const c=await pool.connect();try{await c.query('BEGIN');await c.query(fs.readFileSync(path.join(__dirname,'project_scheduling_down.sql'),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
if(require.main===module){const op=process.argv[2];(op==='down'?rollback():migrate()).catch(e=>{console.error('Project scheduling migration failed:',e.code||e.message);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={migrate,rollback};
