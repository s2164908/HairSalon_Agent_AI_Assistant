// FIX P0-2: degrade instead of throw. The upstream Data Table node now has
// onError=continueRegularOutput, so a backend failure arrives as {error:...}
// instead of crashing the whole execution.
const items = $input.all().map(i => i.json);
const degraded = items.some(r => r && r.error);
// Conversation state re-exports the normalized ctx plus the slot bag, so every
// snapshot carries both and tools can read either from one place.
const ctx = $('Conversation state').first().json;
const rows = degraded ? [] : items.filter(r => r && r.__IDFIELD__);
return [{ json: { ...ctx, rows, degraded } }];
