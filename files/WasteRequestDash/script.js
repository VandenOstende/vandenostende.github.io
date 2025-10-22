let allData = [];
let currentData = [];
let currentSort = { column: null, asc: true };

const fileInput = document.getElementById('fileInput');
const searchInput = document.getElementById('searchInput');
const tableHead = document.getElementById('tableHead');
const tableBody = document.getElementById('tableBody');

const settingsIcon = document.getElementById('settingsIcon');
const modal = document.querySelector('.modal');
const modalOverlay = document.querySelector('.modal-overlay');
const openFileBtn = document.getElementById('openFileBtn');
const closeModal = document.getElementById('closeModal');
const clearStorageModal = document.getElementById('clearStorageModal');

// Verberg originele file input
fileInput.style.display = "none";

// EVENTS
fileInput.addEventListener('change', handleFile);
searchInput.addEventListener('input', handleSearch);

settingsIcon.addEventListener('click', () => {
  const code = prompt("Voer pincode in:");
  if (code === "1883") {
    modal.style.display = "block";
    modalOverlay.style.display = "block";
  } else if(code !== null) {
    alert("Onjuiste pincode");
  }
});

closeModal.addEventListener('click', () => {
  modal.style.display = "none";
  modalOverlay.style.display = "none";
});

modalOverlay.addEventListener('click', () => {
  modal.style.display = "none";
  modalOverlay.style.display = "none";
});

openFileBtn.addEventListener('click', () => {
  fileInput.click();
  modal.style.display = "none";
  modalOverlay.style.display = "none";
});

clearStorageModal.addEventListener('click', () => {
  if (confirm("Weet je zeker dat je alle gegevens wilt wissen?")) {
    localStorage.removeItem('dashboardData');
    allData = [];
    currentData = [];
    renderTable([]);
    modal.style.display = "none";
    modalOverlay.style.display = "none";
  }
});

// DATUM PARSER
function parseExcelDate(value) {
  if (!value) return null;
  if (typeof value === "number") return new Date((value - 25569) * 86400 * 1000);
  if (typeof value === "string") {
    const parts = value.split("-");
    if (parts.length === 3) {
      if (parts[0].length === 4) return isNaN(new Date(value)) ? null : new Date(value);
      const [d, m, y] = parts;
      const date = new Date(`${y}-${m}-${d}`);
      return isNaN(date.getTime()) ? null : date;
    } else {
      const date = new Date(value);
      return isNaN(date.getTime()) ? null : date;
    }
  }
  return null;
}

// IMPORT EXCEL
function handleFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    const headers = json[2];
    const rows = json.slice(3).map(row => {
      let obj = {};
      headers.forEach((header, i) => {
        let value = row[i];
        if (header === "Datum aanvraag" || header === "Bev. transportdat.") {
          const dateObj = parseExcelDate(value);
          value = dateObj ? dateObj.toISOString().split('T')[0] : "";
        }
        obj[header] = value ?? '';
      });
      return obj;
    });

    mergeData(rows);
    currentData = [...allData];
    renderTable(currentData);
  };
  reader.readAsArrayBuffer(file);
}

// MERGE DATA
function mergeData(newRows) {
  const key = "Aanvraagnr.";
  const existing = JSON.parse(localStorage.getItem("dashboardData")) || [];

  const combined = [...existing];
  newRows.forEach(row => {
    if (!combined.some(item => item[key] === row[key])) combined.push(row);
  });

  allData = combined;
  localStorage.setItem("dashboardData", JSON.stringify(allData));
}

// RENDER TABEL
function renderTable(data) {
  tableHead.innerHTML = '';
  tableBody.innerHTML = '';
  if (data.length === 0) return;

  const headers = Object.keys(data[0]);
  const headerRow = document.createElement('tr');

  const alphaColumns = ["Afvalstof"];
  const dateColumns = ["Datum aanvraag", "Bev. transportdat."];

  headers.forEach(header => {
    const th = document.createElement('th');
    th.textContent = header;

    if (alphaColumns.includes(header) || dateColumns.includes(header)) {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => sortByColumn(header));
    }

    if (currentSort.column === header) {
      const arrow = document.createElement('span');
      arrow.textContent = currentSort.asc ? '▲' : '▼';
      arrow.style.color = '#009739';
      arrow.style.marginLeft = '5px';
      th.appendChild(arrow);
    }

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

// FILTER
function handleSearch(e) {
  const term = e.target.value.toLowerCase();
  currentData = allData.filter(row =>
    Object.values(row).some(val => String(val).toLowerCase().includes(term))
  );

  if (currentSort.column) sortByColumn(currentSort.column, false);
  else renderTable(currentData);
}

// SORT
function sortByColumn(column, toggle = true) {
  const alphaColumns = ["Afvalstof"];
  const dateColumns = ["Datum aanvraag", "Bev. transportdat."];

  if (!alphaColumns.includes(column) && !dateColumns.includes(column)) return;

  if (toggle) {
    if (currentSort.column === column) currentSort.asc = !currentSort.asc;
    else { currentSort.column = column; currentSort.asc = true; }
  } else if (!currentSort.column) { currentSort.column = column; currentSort.asc = true; }

  currentData.sort((a,b) => {
    const statusPriority = status => {
      if (!status) return 2;
      const s = status.toLowerCase();
      return (s==="nieuw" || s==="in behandeling") ? 0 : 1;
    };
    const priA = statusPriority(a["Aanvraag status"]);
    const priB = statusPriority(b["Aanvraag status"]);
    if (priA !== priB) return priA - priB;

    let valA = a[column] ?? '';
    let valB = b[column] ?? '';

    if (dateColumns.includes(column)) {
      const timeA = parseExcelDate(valA)?.getTime() ?? Infinity;
      const timeB = parseExcelDate(valB)?.getTime() ?? Infinity;
      return currentSort.asc ? timeA - timeB : timeB - timeA;
    }

    if (alphaColumns.includes(column)) {
      return currentSort.asc
        ? String(valA).localeCompare(String(valB), 'nl', { numeric:true })
        : String(valB).localeCompare(String(valA), 'nl', { numeric:true });
    }

    return 0;
  });

  renderTable(currentData);
}

// LAAD OPSLAG
window.addEventListener('load', () => {
  const saved = JSON.parse(localStorage.getItem("dashboardData")) || [];
  allData = saved;
  currentData = [...allData];
  renderTable(currentData);
});
