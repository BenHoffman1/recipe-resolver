/**
 * bundleData.js
 *
 * Crawl any number of mod **directories or .jar files** supplied on the
 * command line, collect every JSON that looks like a tag or a recipe,
 * and write one big allData.json:
 *   {
 *     "tags":    [{ "path": "...", "values": [...] }],
 *     "recipes": [{ "path": "...", "data":   {...} }]
 *   }
 *
 * Usage examples
 *   node bundleData.js path\to\MI-2.3.9        # one extracted mod dir
 *   node bundleData.js *.jar                   # many jars
 *   node bundleData.js dirWithMods\*           # mixture
 */

const fs       = require('fs');
const path     = require('path');
const AdmZip   = require('adm-zip');           //  ➜  npm i adm-zip
const outFile  = path.resolve(__dirname, 'allData.json');

const roots = process.argv.slice(2);
if (!roots.length) {
    console.error('Usage: node bundleData.js <modDirOrJar> [...]');
    process.exit(1);
}

const tags    = [];   // { path, values }
const recipes = [];   // { path, data }

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function normalise(p) { return p.replace(/\\/g, '/'); }

async function processFile(virtualPath, jsonStr) {
    let j;
    try { j = JSON.parse(jsonStr); }
    catch { return; /* skip broken JSON */ }

    if (virtualPath.includes('/tags/')) {
        tags.push({ path: virtualPath, values: j.values || [] });
    } else if (virtualPath.includes('/recipe/') || virtualPath.includes('/recipes/')) {
        recipes.push({ path: virtualPath, data: j });
    }
}

/* ---------- scan an extracted folder ------------------------------------- */
async function walkDir(realDir, virtualPrefix = '') {
    const entries = await fs.promises.readdir(realDir, { withFileTypes: true });
    for (const e of entries) {
        const realPath = path.join(realDir, e.name);
        const virtPath = normalise(path.join(virtualPrefix, e.name));

        if (e.isDirectory()) {
            await walkDir(realPath, virtPath);
        } else if (e.isFile() && e.name.endsWith('.json')) {
            const raw = await fs.promises.readFile(realPath, 'utf8');
            await processFile(virtPath, raw);
        }
    }
}

/* ---------- scan a .jar --------------------------------------------------- */
async function walkJar(jarPath) {
    const zip = new AdmZip(jarPath);
    for (const entry of zip.getEntries()) {
        if (entry.entryName.endsWith('.json') && !entry.isDirectory) {
            const raw = entry.getData().toString('utf8');
            await processFile(normalise(entry.entryName), raw);
        }
    }
}

/* -------------------------------------------------------------------------- */
/*  Main loop                                                                 */
/* -------------------------------------------------------------------------- */

(async () => {
    for (let root of roots) {
        root = path.resolve(root);
        try {
            const stat = await fs.promises.stat(root);
            if (stat.isDirectory()) {
                await walkDir(root);                 // extracted folder
            } else if (stat.isFile() && root.endsWith('.jar')) {
                await walkJar(root);                 // zipped mod
            } else {
                console.warn('Skipping:', root);
            }
        } catch (err) {
            console.warn('Cannot read', root, '-', err.message);
        }
    }

    await fs.promises.writeFile(
        outFile,
        JSON.stringify({ tags, recipes }, null, 2),
        'utf8'
    );
    console.log(
        `✅ Wrote ${tags.length} tag files and ${recipes.length} recipe files → ${outFile}`
    );
})();
