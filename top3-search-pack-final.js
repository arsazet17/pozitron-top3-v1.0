(function(){
const binary=atob(window.TOP3_SEARCH_PACK||'');delete window.TOP3_SEARCH_PACK;const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
const COUNT=247976,NEWEST_ID=247986,OLDEST_ID=11,ANCHOR_MS=Date.UTC(2023,5,28,21,25,0);
function valueAt(index){if(index<0||index>=COUNT)return null;const bit=index*10,bi=bit>>3,shift=bit&7,chunk=(bytes[bi]||0)|((bytes[bi+1]||0)<<8)|((bytes[bi+2]||0)<<16);return(chunk>>>shift)&1023;}
function codeAt(index){const v=valueAt(index);return v===null?null:String(v).padStart(3,'0');}
function stampAt(index){const d=new Date(ANCHOR_MS-index*1800000),p=n=>String(n).padStart(2,'0');return{date:`${p(d.getUTCDate())}.${p(d.getUTCMonth()+1)}.${String(d.getUTCFullYear()).slice(-2)}`,time:`${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`};}
function rowAt(index){const code=codeAt(index);if(code===null)return null;const s=stampAt(index);return{id:NEWEST_ID-index,date:s.date,time:s.time,a:+code[0],b:+code[1],c:+code[2],searchOnly:true,syntheticTime:true};}
function indexById(id){const i=NEWEST_ID-Number(id);return i>=0&&i<COUNT?i:-1;}
function queryMatch(index,q){const code=codeAt(index),v=[+code[0],+code[1],+code[2]],d=q.digits,s=q.scope;if(q.length===1){if(s==='1')return v[0]===d[0];if(s==='2')return v[1]===d[0];if(s==='3')return v[2]===d[0];return v.includes(d[0]);}if(q.length===2){const pos=s==='12'?[[0,1]]:s==='23'?[[1,2]]:s==='13'?[[0,2]]:[[0,1],[1,2],[0,2]];const unordered=/unordered|any-order|any_unordered/i.test(s);return pos.some(([a,b])=>unordered?((v[a]===d[0]&&v[b]===d[1])||(v[a]===d[1]&&v[b]===d[0])):(v[a]===d[0]&&v[b]===d[1]));}if(q.length===3){if(s==='unordered')return [...v].sort((a,b)=>a-b).join('')===[...d].sort((a,b)=>a-b).join('');return v[0]===d[0]&&v[1]===d[1]&&v[2]===d[2];}return false;}
window.TOP3_SEARCH_ARCHIVE=Object.freeze({count:COUNT,newestId:NEWEST_ID,oldestId:OLDEST_ID,anchor:'28.06.23 21:25',oldestAssigned:'06.05.09 17:55',codeAt,rowAt,codeById:id=>{const i=indexById(id);return i<0?null:codeAt(i);},rowById:id=>{const i=indexById(id);return i<0?null:rowAt(i);},forEachMatch:(q,cb)=>{for(let i=0;i<COUNT;i++)if(queryMatch(i,q))cb(i,rowAt(i));}});
})();
