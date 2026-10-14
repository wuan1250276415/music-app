const code=/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;
const printed=/^[A-Z]{2}-[A-Z0-9]{3}-[0-9]{2}-[0-9]{5}$/;
export function normalizeISRC(raw:unknown):string|null {
 if(typeof raw!=='string'||raw.length>64||/[\u0000-\u001f\u007f]/.test(raw))return null;
 const value=raw.trim().toUpperCase();return code.test(value)?value:printed.test(value)?value.replaceAll('-',''):null;
}
export function localISRCs(raw:unknown):{codes:string[];invalidCount:number} {
 if(raw===undefined||raw===null)return {codes:[],invalidCount:0};
 if(!Array.isArray(raw)||raw.length>128||raw.some(v=>typeof v!=='string'||v.length>16384))throw new Error('本地录音编码来源超过预算或无效');
 const values=raw.map(normalizeISRC);return {codes:[...new Set(values.filter((v):v is string=>v!==null))],invalidCount:values.filter(v=>v===null).length};
}
