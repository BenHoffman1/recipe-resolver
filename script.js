// script.js

// ———————————————————————————————————————————————————————————————
// In-memory indexes & autocomplete source
// ———————————————————————————————————————————————————————————————
let tagsMap      = {};
let recipeIndex  = {};
let allItems     = [];
let initialized  = false;

// at the top, after grabbing your UI elements
const videoEl  = document.getElementById('loader-video');
let videoReady = false;

// make sure the browser actually downloads the video
videoEl.preload = 'auto';
videoEl.load();

// once metadata is loaded we know the duration
videoEl.addEventListener('loadedmetadata', () => {
    videoReady = true;
    // start playback so buffering happens
    videoEl.play().catch(() => {/* playback might be blocked, but buffer should still fill */});
});






// ———————————————————————————————————————————————————————————————
// 1) Initialization: load manifest, build tagsMap, recipeIndex, allItems
// ———————————————————————————————————————————————————————————————
async function init() {
    // 1) load manifest
    const manifest   = await fetch('manifest.json').then(r => r.json());
    const tagPaths    = manifest.tags;
    const recipePaths = manifest.recipes;
    const totalCount  = tagPaths.length + recipePaths.length;
    let loadedCount   = 0;

    // grab UI elements
    const titleEl = document.getElementById('loader-title');
    const barEl   = document.getElementById('loader-progress');

    // helper to bump progress
    function tick() {
        loadedCount++;
        const pct = Math.round((loadedCount / totalCount) * 100);
        barEl.style.width     = pct + '%';
        titleEl.textContent   = `Loading recipes (${pct}%)`;
        if (videoReady && videoEl.duration) {
            videoEl.currentTime = Math.min(
                videoEl.duration * (loadedCount / totalCount),
                videoEl.duration
            );
        }
    }

    // 2) fetch *all* tags in parallel
    const tagFiles = await Promise.all(
        tagPaths.map(async path => {
            const data = await fetch(path).then(r => r.json());
            tick();
            return { path, values: data.values || [] };
        })
    );
    tagsMap = buildTagMap(tagFiles);

    // 3) fetch *all* recipes in parallel
    const recipeFiles = await Promise.all(
        recipePaths.map(async path => {
            const data = await fetch(path).then(r => r.json());
            tick();
            return { path, data };
        })
    );
    recipeIndex = buildRecipeIndex(recipeFiles);

    // 4) build autocomplete and finish
    allItems = Object.keys(recipeIndex).sort();
    setupAutocomplete();
    initialized = true;
}


// ———————————————————————————————————————————————————————————————
// 2) Tag & Recipe index builders (same as before)
// ———————————————————————————————————————————————————————————————

class Recipe {
    constructor(path, data) {
        this.path = path;
        this.data = data;
        this.outputs = this._getOutputs();
    }

    _getOutputs() {
        const d = this.data, outs = [];
        if (d.item_outputs) {
            const arr = Array.isArray(d.item_outputs) ? d.item_outputs : [d.item_outputs];
            arr.forEach(o => {
                if (typeof o === 'string') outs.push([o, 1]);
                else {
                    const id = o.item || o.id;
                    if (id) outs.push([id, o.amount || o.count || 1]);
                }
            });
        } else if (d.result) {
            const r = d.result;
            if (typeof r === 'string') outs.push([r, 1]);
            else {
                const id = r.item || r.id;
                if (id) outs.push([id, r.count || 1]);
            }
        } else if (d.results) {
            d.results.forEach(o => {
                const id = (typeof o === 'string' ? o : (o.item || o.id));
                if (id) outs.push([id, typeof o === 'object' ? (o.count || 1) : 1]);
            });
        }
        return outs;
    }

    getInputs() {
        const items = [], d = this.data;
        function add(e, amt=1) {
            if (typeof e === 'string')      items.push([e, amt]);
            else if (e.item || e.id)        items.push([e.item || e.id, amt]);
            else if (e.tag)                 items.push([`#${e.tag}`, amt]);
        }

        if (d.item_inputs) {
            const arr = Array.isArray(d.item_inputs) ? d.item_inputs : [d.item_inputs];
            arr.forEach(obj => add(obj.item||obj.id||obj.tag||obj, obj.amount||1));
        } else if (d.ingredients) {
            d.ingredients.forEach(ing => add(ing, typeof ing==='object'?(ing.count||1):1));
        } else if (d.key && d.pattern) {
            const freq = {};
            d.pattern.join('').split('').forEach(ch=>freq[ch]=(freq[ch]||0)+1);
            Object.entries(d.key).forEach(([ch,ing])=>{
                if(freq[ch]) add(ing, freq[ch]);
            });
        } else if (d.ingredient) {
            add(d.ingredient);
        }

        return items;
    }
}

function buildTagMap(tagFiles) {
    const map = {};
    tagFiles.forEach(({ path, values }) => {
        const idx = path.indexOf('/data/');
        const rel = idx>=0 ? path.slice(idx+6) : path;
        const parts = rel.split('/');
        const ns    = parts[0];
        const tagIdx= parts.includes('items')?parts.indexOf('items'):parts.indexOf('item');
        const name  = parts.slice(tagIdx+1).join('/').replace(/\.json$/,'');
        map[`#${ns}:${name}`] = values;
    });
    return map;
}

function buildRecipeIndex(recipeFiles) {
    const idx = {};
    recipeFiles.forEach(({ path, data }) => {
        const r = new Recipe(path, data);
        r.outputs.forEach(([out]) => {
            if (!idx[out]) idx[out] = [];
            idx[out].push(r);
        });
    });
    return idx;
}

// ———————————————————————————————————————————————————————————————
// 3) Core resolver logic (furnace, tags, assembler, scoring, etc.)
// ———————————————————————————————————————————————————————————————

function concreteFromTag(tag) {
    const seen = new Set([tag]), queue = [tag];
    while (queue.length) {
        const t = queue.shift(), vals = tagsMap[t] || [];
        for (const v of vals) {
            if (v.startsWith('#') && !seen.has(v)) {
                seen.add(v);
                queue.push(v);
            } else if (!v.startsWith('#')) {
                return v;
            }
        }
    }
    return null;
}

function addCounters(a, b) {
    const out = {...a};
    Object.entries(b).forEach(([k,v])=>{
        out[k] = (out[k]||0) + v;
    });
    return out;
}

function scoreRecipe(r, item) {
    const ins = r.getInputs();
    const same     = ins.some(([i]) => i===item || i===`#${item}`);
    const compress = ins.some(([i]) => i.includes('_block')||i.includes(':block'));
    const dustBonus= ins.some(([i]) => i.includes('dust'));
    const oreBonus = ins.some(([i]) => i.includes('ore'));
    return ins.length + (same?8:0) + (compress?4:0) - (dustBonus?2:0) - (oreBonus?1:0);
}

function resolve(item, qty, cache={}, stack=new Set()) {
    const key = `${item}:${qty}`;
    if (cache[key]) return {...cache[key]};

    // 1) furnace → dust
    {
        const recsAll = recipeIndex[item] || [];
        const F = new Set(['minecraft:smelting','minecraft:blasting','minecraft:smoking']);
        if (recsAll.some(r=>F.has(r.data.type))) {
            const mat    = item.split(':').pop().replace(/_ore$|_ingot$/,'');
            const dustTag= `#c:dusts/${mat}`;
            const cd     = concreteFromTag(dustTag);
            if (cd) return cache[key] = {[cd]: qty};
        }
    }

    // 2) implicit tag expand
    if (!item.startsWith('#') && tagsMap[`#${item}`]) item = `#${item}`;
    if (item.startsWith('#')) {
        const ci = concreteFromTag(item);
        if (!ci) return cache[key] = {[item]:qty};
        item = ci;
    }

    // 3) ignore templates
    if (item.startsWith('modern_industrialization:') && item.endsWith('_template'))
        return cache[key] = {};

    // 4) dust terminal
    const nm = item.split(':').pop();
    if (nm.includes('dust') && !nm.includes('tiny'))
        return cache[key] = {[item]:qty};

    // 5) cycle guard
    if (stack.has(item)) return cache[key] = {[item]:qty};

    // 6) assembler-first
    const recs = recipeIndex[item] || [];
    for (const c of recs) {
        if (c.data.type?.endsWith(':assembler')) {
            let sub = {};
            c.getInputs().forEach(([i,amt])=>{
                sub = addCounters(sub, resolve(i, amt*qty, cache, stack));
            });
            return cache[key] = sub;
        }
    }

    // 7) raw fallback
    if (!recs.length) return cache[key] = {[item]:qty};

    // 8) scored recipes
    const sorted = recs.slice().sort((a,b)=>scoreRecipe(a,item)-scoreRecipe(b,item));
    for (const c of sorted) {
        const mult = Math.ceil(qty / c.outputs[0][1]);
        stack.add(item);
        let sub = {}, bad = false;
        for (const [i,amt] of c.getInputs()) {
            const part = resolve(i, amt*mult, cache, stack);
            sub = addCounters(sub, part);
            if ([...stack].some(x=>sub[x]>0)) { bad = true; break; }
        }
        stack.delete(item);
        if (!bad) return cache[key] = sub;
    }

    // 9) final fallback
    return cache[key] = {[item]:qty};
}

// ———————————————————————————————————————————————————————————————
// 4) Autocomplete setup (uses the now-populated allItems)
// ———————————————————————————————————————————————————————————————

function setupAutocomplete() {
    const inp  = document.getElementById('item');
    const list = document.getElementById('autocomplete-list');
    let focus  = -1;

    inp.addEventListener('input', function(){
        const val = this.value;
        list.innerHTML = '';
        focus = -1;
        if (!val) return;
        allItems
            .filter(i => i.toLowerCase().includes(val.toLowerCase()))
            .slice(0,20)
            .forEach(it => {
                const div = document.createElement('div');
                div.className = 'autocomplete-item';
                const re = new RegExp(val,'i');
                div.innerHTML  = it.replace(re, m=>`<strong>${m}</strong>`);
                div.dataset.val = it;
                div.addEventListener('click', ()=>{
                    inp.value = it;
                    list.innerHTML = '';
                });
                list.appendChild(div);
            });
    });

    inp.addEventListener('keydown', function(e){
        const items = list.querySelectorAll('.autocomplete-item');
        if      (e.key==='ArrowDown') { focus = (focus+1)%items.length; setActive(items); e.preventDefault(); }
        else if (e.key==='ArrowUp')   { focus = (focus-1+items.length)%items.length; setActive(items); e.preventDefault(); }
        else if (e.key==='Enter'||e.key==='Tab') {
            if (focus>-1 && items[focus]) {
                inp.value = items[focus].dataset.val;
                e.preventDefault();
            }
            list.innerHTML = '';
        } else focus = -1;
    });

    function setActive(items) {
        items.forEach(x=>x.classList.remove('autocomplete-active'));
        if (focus>-1 && items[focus]) items[focus].classList.add('autocomplete-active');
    }

    document.addEventListener('click', e=>{
        if (e.target!==inp) list.innerHTML = '';
    });
}

// ———————————————————————————————————————————————————————————————
// 5) Form submission → run resolver
// ———————————————————————————————————————————————————————————————
document.getElementById('resolver-form').addEventListener('submit', async e=>{
    e.preventDefault();
    // if (!initialized) await init();

    const item      = document.getElementById('item').value.trim();
    const qty       = parseInt(document.getElementById('quantity').value,10)||1;
    const sortByQty = document.getElementById('sortByQuantity').checked;

    const bom = resolve(item, qty);
    let entries = Object.entries(bom);
    if (sortByQty)
        entries.sort((a,b)=>b[1]-a[1]);
    else
        entries.sort((a,b)=>a[0].localeCompare(b[0]));

    let out = `=== Bill of Materials ===\n${qty} × ${item}\n\n`;
    entries.forEach(([itm,c])=>{ if(c) out+=`  ${c} × ${itm}\n`; });

    document.getElementById('output').textContent = out;
});

// As soon as the DOM is ready, fetch manifest/tags/recipes and wire up autocomplete
document.addEventListener('DOMContentLoaded', async () => {
    // Show loader (already visible by default)
    await init();                     // fetch + build indexes
    // Once init completes:
    document.getElementById('loader').style.display = 'none';
    document.getElementById('app').style.display    = 'block';
});
