const fileInput = document.getElementById('fileInput');
const searchInput = document.getElementById('searchInput');
const tableHead = document.getElementById('tableHead');
const tableBody = document.getElementById('tableBody');
const clearStorage = document.getElementById('clearStorage');

// Laad bestaande data uit localStorage
let storedData = JSON.parse(localStorage.getItem('afvalData')) || [];
renderTable(storedData);

// Eventlisteners
fileInput.addEventListener('change', handleFile);
searchInput.addEventListener('input', handleSearch);
clearStorage.addEventListener('click', () => {
  localStorage.removeItem('afvalData');
  storedData = [];
  renderTable([]);
});

// Verwerk Excel-bestand
function handleFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

    const allRows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: "" });

    const headers = allRows[2]; // rij 3
    const dataRows = allRows.slice(3);

    const jsonData = dataRows.map(row => {
      const obj = {};
      headers.forEach((header, i) => {
        obj[header] = row[i] ?? "";
      });
      return obj;
    });

    mergeData(jsonData);
  };
  reader.readAsArrayBuffer(file);
}

// Voeg enkel nieuwe records toe (uniek op "Aanvraagnr.")
function mergeData(newData) {
  const existingIds = new Set(storedData.map(item => item["Aanvraagnr."]));
  const uniqueNewData = newData.filter(item => !existingIds.has(item["Aanvraagnr."]));

  if (uniqueNewData.length > 0) {
    storedData = [...storedData, ...uniqueNewData];
    localStorage.setItem('afvalData', JSON.stringify(storedData));
  }

  renderTable(storedData);
}

// Tabel renderen
function renderTable(data) {
  tableHead.innerHTML = "";
  tableBody.innerHTML = "";

  if (data.length === 0) return;

  c
