#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'run-audit.js');
let s = fs.readFileSync(file, 'utf8');
const start = s.indexOf("    log('Invalid grid");
const end = s.indexOf("    log('AI: solver-driven");
if (start < 0 || end < 0) {
    console.error('markers not found', start, end);
    process.exit(1);
}
s = s.slice(0, start) + s.slice(end);
fs.writeFileSync(file, s);
console.log('removed fixture block', end - start, 'chars');
