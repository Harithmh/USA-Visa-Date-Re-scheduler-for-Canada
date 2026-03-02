// Popup initialization: load saved settings, render city chips, and wire events.
document.addEventListener('DOMContentLoaded', () => {
  // Default city list shown as selectable chips.
  const DEFAULT_CITIES = ["Calgary", "Halifax", "Montreal", "Ottawa", "Quebec City", "Toronto", "Vancouver"];
  // Uses a Set for easy add/remove toggling.
  let selectedCities = new Set();

  // Storage keys tied to popup inputs.
  const elements = [
    'loginEmail', 'loginPass', 'startDate', 'endDate', 'minDelay', 'maxDelay', 'frequencyUnit',
    'toggleActive', 'toggleAutobook', 'debugOverlay'
  ];
  
  // Load all saved settings and hydrate form UI.
  chrome.storage.local.get(null, (data) => {
    elements.forEach(id => {
      const el = document.getElementById(id);
      if (el.type === 'checkbox') {
        el.checked = data[id] || false;
        return;
      }
      if (data[id]) {
        el.value = data[id];
        return;
      }
      el.value = id.includes('Delay') ? el.value : '';
    });
    if (data.preferredCities) selectedCities = new Set(data.preferredCities);
    renderChips();
  });

  // Draw city chips and reflect selected state.
  function renderChips() {
    const chipsEl = document.getElementById('chips');
    chipsEl.innerHTML = "";
    DEFAULT_CITIES.forEach(city => {
      const chip = document.createElement('div');
      chip.className = 'chip' + (selectedCities.has(city) ? ' on' : '');
      chip.textContent = city;
      chip.onclick = () => {
        selectedCities.has(city) ? selectedCities.delete(city) : selectedCities.add(city);
        renderChips();
        save();
      };
      chipsEl.appendChild(chip);
    });
    document.getElementById('cityHint').textContent = `${selectedCities.size} cities selected`;
  }

  // Persist current popup values back to extension local storage.
  function save() {
    const settings = { preferredCities: Array.from(selectedCities) };
    elements.forEach(id => {
      const el = document.getElementById(id);
      settings[id] = el.type === 'checkbox' ? el.checked : el.value;
    });
    chrome.storage.local.set(settings);
  }

  // Save whenever any input/select value changes.
  document.querySelectorAll('input, select').forEach(el => el.onchange = save);
  // Full reset: clear settings then reload popup to defaults.
  document.getElementById('resetBtn').onclick = () => { chrome.storage.local.clear(); location.reload(); };
});