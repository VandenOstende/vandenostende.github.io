const fileInput = document.getElementById('fileInput');
const searchInput = document.getElementById('searchInput');
const tableHead = document.getElementById('tableHead');
const tableBody = document.getElementById('tableBody');
const clearStorage = document.getElementById('clearStorage');

let storedData = JSON.parse(localStorage.getItem('afvalData')) || [];
renderTable(storedData);

fileInput.addEventListener('change', handleFile);
searchInput.addEventListener('input', handleSearch);
clearStorage.addEventListener('click', () => {
  localStorage.removeItem('afvalData');
  storedData = [];
  renderTable([]);
});

function handleFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const allRows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: "" });

    // headers starten in rij 3 (index 2)
    const headers = allRows[2];
    const dataRows = allRows.slice(3);

    const jsonData = dataRows.map(row => {
      const obj = {};
      headers.forEach((header, i) => obj[header] = row[i]);
      return obj;
    });

    mergeData(jsonData);
  };
  reader.readAsArrayBuffer(file);
}

function mergeData(newData) {
  const existingIds = new Set(storedData.map(item => item["Aanvraagnr."]));
  const uniqueNewData = newData.filter(item => !existingIds.has(item["Aanvraagnr."]));

  if (uniqueNewData.length > 0) {
    storedData = [...storedData, ...uniqueNewData];
    localStorage.setItem('afvalData', JSON.stringify(storedData));
  }

  renderTable(storedData);
}

function renderTable(data) {
  tableHead.innerHTML = "";
  tableBody.innerHTML = "";

  if (!data || data.length === 0) return;

  const headers = Object.keys(data[0]);

  const headerRow = document.createElement('tr');
  headers.forEach(header => {
    const th = document.createElement('th');
    th.textContent = header;
    headerRow.appendChild(th);
  });
  tableHead.appendChild(headerRow);

  data.forEach(row => {
    const tr = document.createElement('tr');
    headers.forEach(header => {
      const td = document.createElement('td');
      td.textContent = row[header];
      tr.appendChild(td);
    });
    tableBody.appendChild(tr);
  });
}

function handleSearch(e) {
  const query = e.target.value.toLowerCase();
  const filtered = storedData.filter(row =>
    Object.values(row).some(val =>
      String(val).toLowerCase().includes(query)
    )
  );
  renderTable(filtered);
}
