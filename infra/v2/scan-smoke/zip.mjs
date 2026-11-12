// Writes a stored (uncompressed) zip archive of the named files, each under its base name: the layout of an OSV
// offline database's `all.zip`, one advisory JSON per entry. The gate image has Node but no zip tool.
//
// Usage: node zip.mjs <out.zip> <file>...
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { crc32 } from "node:zlib";

const [out, ...files] = process.argv.slice(2);
if (out === undefined || files.length === 0) {
  process.stderr.write("usage: node zip.mjs <out.zip> <file>...\n");
  process.exit(2);
}

// 1980-01-01 00:00, the earliest MS-DOS date, so the archive's bytes depend on its inputs only.
const DOS_DATE = 0x21;
const locals = [];
const centrals = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(basename(file), "utf8");
  const data = readFileSync(file);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  locals.push(local, name, data);
  centrals.push(central, name);
  offset += local.length + name.length + data.length;
}
const directory = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
writeFileSync(out, Buffer.concat([...locals, directory, end]));
