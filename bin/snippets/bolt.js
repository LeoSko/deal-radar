// Paste into the DevTools console of a logged-in food.bolt.eu tab.
// Copies {refresh_token, city_slug} to the clipboard. Bolt keeps its tokens in
// an XOR-obfuscated react-native-MMKV blob in localStorage; the JWT with a
// multi-day lifetime is the refresh bearer.
copy(JSON.stringify((()=>{const dec=s=>{let o="";for(let i=0;i<s.length;i++)o+=String.fromCharCode(s.charCodeAt(i)^24);return o;};const d=dec(localStorage["mmkv_9$a_store_9$a_persist:root"]);const tok=(d.match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g)||[]).find(t=>{try{const p=JSON.parse(atob(t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));return p.exp-p.iat>86400;}catch{return false;}});return {refresh_token:tok,city_slug:(location.pathname.match(/^\/[a-z]{2}(?:-[A-Za-z]{2})?\/([^\/?#]+)/)||[])[1]||null}})()));console.log("Copied to clipboard!")
