import { readFile, writeFile } from 'node:fs/promises';
const path=new URL('./.agent-state.json',import.meta.url);
export async function loadState(fallback){try{return {...fallback,...JSON.parse(await readFile(path,'utf8'))}}catch(err){if(err.code==='ENOENT')return fallback;throw err}}
export async function saveState(state){await writeFile(path,JSON.stringify(state,null,2),{mode:0o600})}
