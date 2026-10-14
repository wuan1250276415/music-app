const {spawnSync}=require('node:child_process'),path=require('node:path');
const result=spawnSync(process.execPath,[path.join(__dirname,'../tests/electron-online-artwork-e2e.smoke.cjs')],{stdio:'inherit',env:{...process.env,AURAL_ONLINE_E2E_LIVE:'0',AURAL_ONLINE_E2E_RELEASE_FIELDS:'1'},windowsHide:true});
if(result.error)throw result.error;process.exitCode=result.status??1;
