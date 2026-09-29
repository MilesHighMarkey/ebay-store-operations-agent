import { readFile, writeFile, rename } from 'node:fs/promises';
const defaultPath=new URL('./.agent-state.json',import.meta.url);
const getPath=()=>process.env.STATE_STORE_PATH||defaultPath;
export async function loadState(fallback){const path=getPath();try{return {...fallback,...JSON.parse(await readFile(path,'utf8'))}}catch(err){if(err.code==='ENOENT')return fallback;throw err}}
export async function saveState(state){const path=getPath();const temp=typeof path==='string'?`${path}.tmp`:new URL('./.agent-state.json.tmp',import.meta.url);await writeFile(temp,JSON.stringify(state,null,2),{mode:0o600});await rename(temp,path)}
