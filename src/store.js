import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('data/db.json');
fs.mkdirSync(path.dirname(FILE), { recursive: true });

const defaults = { banned: [], admins: [], groups: {}, users: {}, history: {} };
let data = structuredClone(defaults);
try {
  data = { ...defaults, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch {}

let timer;
function flush() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

export const db = {
  data,
  save() {
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  },
};

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flush();
    process.exit(0);
  });
}
