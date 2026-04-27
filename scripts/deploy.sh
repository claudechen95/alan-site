#!/bin/bash
set -e

VERSION=$(node -e "
const fs = require('fs');
const v = JSON.parse(fs.readFileSync('version.json'));
v.version++;
fs.writeFileSync('version.json', JSON.stringify(v, null, 2) + '\n');
process.stdout.write(String(v.version));
")

echo "Bumped to v$VERSION"

git add version.json
git commit -m "chore: bump to v$VERSION"
git push
