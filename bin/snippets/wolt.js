// Paste into the DevTools console of a logged-in wolt.com tab.
// Copies {access_token, refresh_token} to the clipboard.
copy(JSON.stringify((()=>{const g=n=>{const m=document.cookie.match(new RegExp(n+"=([^;]+)"));return m?decodeURIComponent(m[1]):null;};const wt=JSON.parse(g("__wtoken")||"{}");return {access_token:wt.accessToken,refresh_token:g("__wrtoken")};})()));console.log("Copied to clipboard!")
