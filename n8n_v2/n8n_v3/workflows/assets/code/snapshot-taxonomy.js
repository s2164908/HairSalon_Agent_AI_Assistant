// FIX P0-2: degrade instead of throw. The upstream Data Table node now has
// onError=continueRegularOutput, so a backend failure arrives as {error:...}
// instead of crashing the whole execution.
const items = $input.all().map(i => i.json);
const degraded = items.some(r => r && r.error);
const ctx = $('Normalize and screen input').first().json;
const rows = degraded ? [] : items.filter(r => r && r.taxonomy_id);
return [{ json: { ...ctx, rows, degraded } }];
