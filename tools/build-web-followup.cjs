// The browser displays exactly the same source/coverage rules as the mini UI.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'miniprogram/utils/followup-summary.js'),'utf8');
const first=source.indexOf('const METRIC_LABELS'),end=source.indexOf('async function fetchFollowupSummary');
if(first<0||end<=first)throw Error('Shared display source boundaries changed; review the build adapter.');
const pure=source.slice(first,end);if(/\brequire\s*\(/.test(pure))throw Error('The display adapter must remain pure.');
const digest=crypto.createHash('sha256').update(source).digest('hex');
fs.writeFileSync(path.join(root,'patient-web/js/followup-display.js'),`/* Generated from mini followup-summary.js sha256=${digest} */\n(() => { 'use strict';\n${pure}\nwindow.FollowupDisplay=Object.freeze({buildFollowupDisplay});\n})();\n`,'utf8');
console.log('Bundled shared followup display.');
