// script.js

// ———————————————————————————————————————————————————————————————
// In-memory indexes & autocomplete source
// ———————————————————————————————————————————————————————————————
let tagsMap      = {};
let recipeIndex  = {};
let allItems     = [];
let initialized  = false;

let lastPlan = [];     // holds the most recent planCraft result
let lastItemID   = null;  // track what we just resolved
let lastItemQty  = 1;

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




// near the top of script.js, after your imports / globals:
function cleanName(name) {
    return name
        .replace(/^fluid:/, '')
        .replace(/^modern_industrialization:/, '')
        .replace(/^minecraft:/, '')
        .replace(/c:/g, '');
}


// ———————————————————————————————————————————————————————————————
// 1) Initialization: load manifest, build tagsMap, recipeIndex, allItems
// ———————————————————————————————————————————————————————————————
async function init() {
    const { tags, recipes } = await fetch('allData.json').then(r => r.json());
    tagsMap     = buildTagMap(tags);
    recipeIndex = buildRecipeIndex(recipes);

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
        if (d.fluid_outputs) {
            const arr = Array.isArray(d.fluid_outputs) ? d.fluid_outputs : [d.fluid_outputs];
            arr.forEach(o => {
                const id = o.fluid;
                if (id) outs.push([`fluid:${id}`, o.amount || 1]); // prefix with "fluid:"
            });
        }

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
        if (d.fluid_inputs) {
            const arr = Array.isArray(d.fluid_inputs) ? d.fluid_inputs : [d.fluid_inputs];
            arr.forEach(obj => {
                if (obj.fluid) items.push([`fluid:${obj.fluid}`, obj.amount || 1]);
            });
        }


        return items;
    }
}

function buildTagMap(tagFiles) {
    const map = {};
    tagFiles.forEach(({path, values}) => {
        const parts = path.replace(/\\/g,'/').split('/');
        // find the index of "data", then the next part is the namespace
        const dataIdx = parts.indexOf('data');
        const ns      = (dataIdx >= 0 && parts.length > dataIdx+1)
            ? parts[dataIdx+1]
            : '???';
        // find where "items" or "item" appears
        const tagIdx  = parts.indexOf('items') >= 0
            ? parts.indexOf('items')
            : parts.indexOf('item');
        const name    = parts.slice(tagIdx+1).join('/').replace(/\.json$/, '');
        const key     = `#${ns}:${name}`;

        // merge values as before…
        if (!map[key]) map[key] = [];
        map[key].push(...values);
    });

    Object.keys(map).forEach(k => map[k] = [...new Set(map[k])]);
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
    // Skip template entirely
    if (item.includes('packer_double_ingot_template')) {
        return {}; // treated as free
    }

    const key = `${item}:${qty}`;
    if (cache[key]) return {...cache[key]};

    // 1) furnace → dust
    {
        const recsAll = recipeIndex[item] || [];
                const F = new Set([
                    'minecraft:smelting',
                    'minecraft:blasting',
                    'minecraft:smoking',
                    'modern_industrialization:blast_furnace',
                    'modern_industrialization:crusher'
                ]);        if (recsAll.some(r=>F.has(r.data.type))) {
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

    // 3) ignore templates (legacy safeguard)
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
                if (!i.includes('packer_double_ingot_template')) {
                    sub = addCounters(sub, resolve(i, amt*qty, cache, stack));
                }
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
            if (i.includes('packer_double_ingot_template')) continue;
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
// 3.1) Craft‑plan: generate step list (machine & runs count)
// ———————————————————————————————————————————————————————————————


/**
 * Given a list of [itemID, qty] pairs, return a flattened
 * map { rawID: totalQty } by feeding each through resolve().
 */
function resolveInputsRaw(inputs) {
    const rawTotals = {};
    inputs.forEach(([id, amt]) => {
        const parts = resolve(id, amt);
        Object.entries(parts).forEach(([rawID, rawAmt]) => {
            rawTotals[rawID] = (rawTotals[rawID] || 0) + rawAmt;
        });
    });
    return rawTotals;
}


/**
 * Build a list of recipe‑runs: each { machine, item, runs, inputs }
 */
function planCraft(item, qty, plan = [], seen = new Set()) {
    // Skip if template itself
    if (item.includes('packer_double_ingot_template')) {
        return plan;
    }

    // 1) terminal dust or raw
    const nm = item.split(':').pop();
    if ((nm.includes('dust') && !nm.includes('tiny')) || !(recipeIndex[item]?.length)) {
        return plan;
    }

    // 2) choose assembler‑first, else best‑scored
    const recs = recipeIndex[item] || [];
    const use = recs.find(r => r.data.type?.endsWith(':assembler'))
        || recs.slice().sort((a,b)=>scoreRecipe(a,item)-scoreRecipe(b,item))[0];
    if (!use) return plan;

    // avoid loops
    const key = `${use.path}|${qty}`;
    if (seen.has(key)) return plan;
    seen.add(key);

    // how many runs are needed
    const outAmt = use.outputs.find(o=>o[0]===item)[1] || 1;
    const runs   = Math.ceil(qty / outAmt);

    // record inputs scaled by runs, skipping template
    const inputs = use.getInputs()
        .filter(([ing]) => !ing.includes('packer_double_ingot_template'))
        .map(([ing,amt]) => [ing, amt * runs]);

    // push this step (now includes recipe path)
    plan.push({
        machine: use.data.type.split(':').pop(),
        item,
        runs,
        inputs,
        path: use.path   // add path to step
    });

    // recurse on each input
    inputs.forEach(([ing, totalAmt])=> {
        planCraft(ing, totalAmt, plan, seen);
    });

    return plan;
}


function renderChecklist(plan) {
    const container  = document.getElementById('planChecklist');
    const showInputs = document.getElementById('showInputs').checked;
    container.innerHTML = '';

    plan.slice().reverse().forEach((step, i) => {
        const li    = document.createElement('li');
        const label = document.createElement('label');
        label.className = 'step-label';

        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.id   = `step-${i}`;

        // Main line: machine, runs, and item
        const span = document.createElement('span');
        span.className = 'step-text';
        span.textContent = `Run ${step.machine} × ${step.runs} → makes ${cleanName(step.item)}`;

        chk.addEventListener('change', () => {
            li.classList.toggle('completed', chk.checked);
        });

        label.appendChild(chk);
        label.appendChild(span);
        li.appendChild(label);

        // **NEW: Show file path under the main line**
        if (step.path) {
            const pathDiv = document.createElement('div');
            pathDiv.className = 'step-path';
            pathDiv.style.fontSize = '0.8em';
            pathDiv.style.opacity = '0.7';
            pathDiv.textContent = `Recipe file: ${step.path}`;
            li.appendChild(pathDiv);
        }

        // Show *raw‑material* inputs if toggle enabled
        if (showInputs && step.inputs.length) {
            const raw = resolveInputsRaw(step.inputs);
            const sub = document.createElement('ul');
            Object.entries(raw).forEach(([ing, amt]) => {
                const subLi = document.createElement('li');
                subLi.textContent = `${amt} × ${cleanName(ing)}`;
                sub.appendChild(subLi);
            });
            li.appendChild(sub);
        }


        container.appendChild(li);
    });

        // ———————————————————————————————————————————————————————————————
        //  Add an “Aggregated Raw Materials” summary (matches your BOM)
        // ———————————————————————————————————————————————————————————————
    if (document.getElementById('showInputs').checked && lastItemID) {
        const summary = resolve(lastItemID, lastItemQty);
        const hdr = document.createElement('h3');
        hdr.textContent = 'Raw Materials (Aggregated):';
        container.appendChild(hdr);

        const ulSum = document.createElement('ul');
        Object.entries(summary).forEach(([ing, amt]) => {
                const li = document.createElement('li');
                li.textContent = `${amt} × ${cleanName(ing)}`;
                ulSum.appendChild(li);
              });
        container.appendChild(ulSum);
        }
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
            .filter(i => cleanName(i).toLowerCase().includes(val.toLowerCase()))
            .slice(0,20)
            .forEach(it => {
                const div = document.createElement('div');
                div.className = 'autocomplete-item';

                // Highlight matches in cleaned name
                const cleaned = cleanName(it);
                const re = new RegExp(val, 'i');
                div.innerHTML  = cleaned.replace(re, m=>`<strong>${m}</strong>`);

                // Keep raw value internally
                div.dataset.val = it;

                div.addEventListener('click', ()=>{
                    inp.value = cleaned;  // show clean name in input
                    list.innerHTML = '';
                });
                list.appendChild(div);
            });
    });

    inp.addEventListener('keydown', function(e){
        const items = list.querySelectorAll('.autocomplete-item');
        if (items.length === 0) return; // No suggestions -> normal Tab behavior

        const isShiftTab = e.key === 'Tab' && e.shiftKey;

        if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
            focus = (focus + 1) % items.length;
            setActive(items);
            ensureVisible(items[focus]);
            e.preventDefault();
        }
        else if (e.key === 'ArrowUp' || isShiftTab) {
            focus = (focus - 1 + items.length) % items.length;
            setActive(items);
            ensureVisible(items[focus]);
            e.preventDefault();
        }
        else if (e.key === 'Enter') {
            if (focus > -1 && items[focus]) {
                inp.value = cleanName(items[focus].dataset.val);
                e.preventDefault();
            }
            list.innerHTML = '';
        }
        else {
            focus = -1;
        }
    });

    // Scroll selection into view
    function ensureVisible(el) {
        if (!el) return;
        const container = list;
        const elTop = el.offsetTop;
        const elBottom = elTop + el.offsetHeight;
        const viewTop = container.scrollTop;
        const viewBottom = viewTop + container.clientHeight;

        if (elTop < viewTop) {
            container.scrollTop = elTop;
        } else if (elBottom > viewBottom) {
            container.scrollTop = elBottom - container.clientHeight;
        }
    }

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
document.getElementById('resolver-form').addEventListener('submit', async e => {
    e.preventDefault();

    // Convert cleaned input to raw ID
    const userInput = document.getElementById('item').value.trim();
    const item = allItems.find(id => cleanName(id) === userInput) || userInput;

    const qty       = parseInt(document.getElementById('quantity').value, 10) || 1;
    const sortByQty = document.getElementById('sortByQuantity').checked;

    // Generate BOM
    const bom = resolve(item, qty);
    let entries = Object.entries(bom)
        .filter(([itm]) => !itm.includes('packer_double_ingot_template'));

    if (sortByQty) {
        entries.sort((a, b) => b[1] - a[1]);
    } else {
        entries.sort((a, b) => a[0].localeCompare(b[0]));
    }

    let out = `=== Bill of Materials ===\n${qty} × ${cleanName(item)}\n\n`;
    entries.forEach(([itm, count]) => {
        if (count) out += `  ${count} × ${cleanName(itm)}\n`;
    });
    document.getElementById('output').textContent = out;

    // Build and render backwards checklist
    lastPlan = planCraft(item, qty);
    lastItemID  = item;
    lastItemQty = qty;
    renderChecklist(lastPlan);
});



// As soon as the DOM is ready, fetch manifest/tags/recipes and wire up autocomplete
document.addEventListener('DOMContentLoaded', async () => {
    // Show loader (already visible by default)
    await init();                     // fetch + build indexes

    document.getElementById('showInputs')
        .addEventListener('change', () => {
            if (lastPlan.length) renderChecklist(lastPlan);
        });

    // Once init completes:
    document.getElementById('loader').style.display = 'none';
    document.getElementById('app').style.display    = 'flex';
});
