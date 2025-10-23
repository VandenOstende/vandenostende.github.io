// Firebase Firestore imports - deze worden geladen via de module in HTML
let db;

// Wacht tot Firebase beschikbaar is
window.addEventListener('load', async () => {
  // Wacht tot Firebase database beschikbaar is
  while (!window.firebaseDb) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  db = window.firebaseDb;
  
  // Laad verborgen kolommen instellingen
  loadHiddenColumns();
  
  // Laad opgeslagen gegevens uit Firestore
  await loadDataFromFirestore();
});

let allData = [];
let currentData = [];
let currentSort = { column: null, asc: true };

const fileInput = document.getElementById('fileInput');
const searchInput = document.getElementById('searchInput');
const tableHead = document.getElementById('tableHead');
const tableBody = document.getElementById('tableBody');
const loadingIndicator = document.getElementById('loadingIndicator');

const settingsIcon = document.getElementById('settingsIcon');
const modal = document.querySelector('.modal');
const modalOverlay = document.querySelector('.modal-overlay');
const openFileBtn = document.getElementById('openFileBtn');
const closeModal = document.getElementById('closeModal');
const clearStorageModal = document.getElementById('clearStorageModal');
const reformatDatesBtn = document.getElementById('reformatDatesBtn');

// Kolom modal elementen
const showColumnModal = document.getElementById('showColumnModal');
const columnModal = document.querySelector('.column-modal');
const columnModalOverlay = document.querySelector('.column-modal-overlay');
const columnCheckboxes = document.getElementById('columnCheckboxes');
const selectAllColumns = document.getElementById('selectAllColumns');
const deselectAllColumns = document.getElementById('deselectAllColumns');
const resetColumnOrder = document.getElementById('resetColumnOrder');
const applyColumnChanges = document.getElementById('applyColumnChanges');
const closeColumnModal = document.getElementById('closeColumnModal');

// Kolom zichtbaarheid en volgorde state
let hiddenColumns = new Set();
let availableColumns = [];
let columnOrder = []; // Nieuwe array om kolom volgorde bij te houden
let originalColumnOrder = []; // Oorspronkelijke volgorde voor reset functie

// Rij detail modal elementen
const rowDetailModal = document.querySelector('.row-detail-modal');
const rowDetailModalOverlay = document.querySelector('.row-detail-modal-overlay');
const rowDetailTitle = document.getElementById('rowDetailTitle');
const rowDetailContent = document.getElementById('rowDetailContent');
const closeRowDetailModal = document.getElementById('closeRowDetailModal');
const closeRowDetailBtn = document.getElementById('closeRowDetailBtn');

// Verberg originele file input
fileInput.style.display = "none";

// EVENTS
fileInput.addEventListener('change', handleFile);
searchInput.addEventListener('input', handleSearch);

settingsIcon.addEventListener('click', () => {
  // Toon het menu direct zonder pincode voor kolom beheer
  modal.style.display = "block";
  modalOverlay.style.display = "block";
});

closeModal.addEventListener('click', () => {
  modal.style.display = "none";
  modalOverlay.style.display = "none";
});

modalOverlay.addEventListener('click', () => {
  modal.style.display = "none";
  modalOverlay.style.display = "none";
});

// Rij detail modal event listeners
closeRowDetailModal.addEventListener('click', () => {
  rowDetailModal.style.display = "none";
  rowDetailModalOverlay.style.display = "none";
});

closeRowDetailBtn.addEventListener('click', () => {
  rowDetailModal.style.display = "none";
  rowDetailModalOverlay.style.display = "none";
});

rowDetailModalOverlay.addEventListener('click', () => {
  rowDetailModal.style.display = "none";
  rowDetailModalOverlay.style.display = "none";
});

// ESC toets om modal te sluiten
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (rowDetailModal.style.display === 'block') {
      rowDetailModal.style.display = "none";
      rowDetailModalOverlay.style.display = "none";
    }
  }
});

openFileBtn.addEventListener('click', () => {
  // Vraag pincode voor Excel import
  const code = prompt("Voer pincode in voor Excel import:");
  if (code === "1883") {
    fileInput.click();
    modal.style.display = "none";
    modalOverlay.style.display = "none";
  } else if(code !== null) {
    alert("Onjuiste pincode");
  }
});

showColumnModal.addEventListener('click', () => {
  if (availableColumns.length === 0) {
    alert('Importeer eerst een Excel bestand om kolommen te kunnen beheren.');
    return;
  }
  
  // Geen pincode vereist voor kolom beheer
  modal.style.display = "none";
  modalOverlay.style.display = "none";
  
  showColumnManagementModal();
});

reformatDatesBtn.addEventListener('click', async () => {
  if (allData.length === 0) {
    alert('Geen data beschikbaar om te herformatteren.');
    return;
  }
  
  console.log('Handmatig herformatteren van alle datums...');
  allData = reformatExistingDates(allData);
  currentData = [...allData];
  
  // Sla de hergeformatteerde data op
  await saveDataToFirestore(allData);
  localStorage.setItem("dashboardData", JSON.stringify(allData));
  
  renderTable(currentData);
  alert('Alle datums zijn hergeformatteerd naar DD-MM-YYYY formaat!');
  
  modal.style.display = "none";
  modalOverlay.style.display = "none";
});

closeColumnModal.addEventListener('click', () => {
  columnModal.style.display = "none";
  columnModalOverlay.style.display = "none";
});

columnModalOverlay.addEventListener('click', () => {
  columnModal.style.display = "none";
  columnModalOverlay.style.display = "none";
});

selectAllColumns.addEventListener('click', () => {
  const checkboxes = columnCheckboxes.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach(cb => cb.checked = true);
});

deselectAllColumns.addEventListener('click', () => {
  const checkboxes = columnCheckboxes.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach(cb => cb.checked = false);
});

applyColumnChanges.addEventListener('click', () => {
  updateHiddenColumns();
  updateColumnOrder();
  renderTable(currentData);
  columnModal.style.display = "none";
  columnModalOverlay.style.display = "none";
});

resetColumnOrder.addEventListener('click', () => {
  if (confirm('Weet je zeker dat je de kolom volgorde wilt resetten naar de oorspronkelijke volgorde?')) {
    columnOrder = [...originalColumnOrder];
    showColumnManagementModal(); // Ververs de modal om de nieuwe volgorde te tonen
  }
});

clearStorageModal.addEventListener('click', async () => {
  // Vraag pincode voor data wissen
  const code = prompt("Voer pincode in voor gegevens wissen:");
  if (code === "1883") {
    if (confirm("Weet je zeker dat je alle gegevens wilt wissen?")) {
      await clearFirestoreData();
      allData = [];
      currentData = [];
      renderTable([]);
      modal.style.display = "none";
      modalOverlay.style.display = "none";
    }
  } else if(code !== null) {
    alert("Onjuiste pincode");
  }
});

// DATUM PARSER
function parseExcelDate(value) {
  if (!value) return null;
  
  // Als het een nummer is (Excel datum serialnummer)
  if (typeof value === "number") {
    // Excel datum serialnummer naar JavaScript Date
    const date = new Date((value - 25569) * 86400 * 1000);
    return isNaN(date.getTime()) ? null : date;
  }
  
  if (typeof value === "string") {
    // Probeer verschillende datum formaten
    
    // Format: DD-MM-YYYY of DD/MM/YYYY
    const ddmmyyyy = value.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (ddmmyyyy) {
      const [, day, month, year] = ddmmyyyy;
      const date = new Date(year, month - 1, day);
      return isNaN(date.getTime()) ? null : date;
    }
    
    // Format: YYYY-MM-DD
    const yyyymmdd = value.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
    if (yyyymmdd) {
      const [, year, month, day] = yyyymmdd;
      const date = new Date(year, month - 1, day);
      return isNaN(date.getTime()) ? null : date;
    }
    
    // Format: DD.MM.YYYY
    const ddmmyyyyDot = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (ddmmyyyyDot) {
      const [, day, month, year] = ddmmyyyyDot;
      const date = new Date(year, month - 1, day);
      return isNaN(date.getTime()) ? null : date;
    }
    
    // Probeer standaard Date parsing als laatste optie
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
  
  return null;
}

// Functie om datum naar Nederlandse notatie te formatteren
function formatDateDutch(date) {
  if (!date) return '';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

// Functie om bestaande data opnieuw te formatteren
function reformatExistingDates(data) {
  if (!data || data.length === 0) return data;
  
  const dateKeywords = [
    'datum', 'date', 'transportdat', 'ophaal', 'aflevering', 
    'pickup', 'delivery', 'aanvraag', 'bev.', 'gepland'
  ];
  
  return data.map(row => {
    const newRow = { ...row };
    
    Object.keys(newRow).forEach(header => {
      const isDateColumn = dateKeywords.some(keyword => 
        header.toLowerCase().includes(keyword.toLowerCase())
      );
      
      if (isDateColumn && newRow[header]) {
        const value = newRow[header];
        
        // Check if het al in DD-MM-YYYY formaat is
        if (typeof value === 'string' && value.match(/^\d{1,2}-\d{1,2}-\d{4}$/)) {
          return; // Al correct geformatteerd
        }
        
        // Check if het in YYYY-MM-DD formaat is
        if (typeof value === 'string' && value.match(/^\d{4}-\d{1,2}-\d{1,2}$/)) {
          const dateObj = new Date(value);
          if (!isNaN(dateObj.getTime())) {
            newRow[header] = formatDateDutch(dateObj);
            console.log(`Datum herformatteerd: ${value} -> ${newRow[header]}`);
          }
          return;
        }
        
        // Probeer andere formaten te parsen
        const dateObj = parseExcelDate(value);
        if (dateObj) {
          newRow[header] = formatDateDutch(dateObj);
          console.log(`Datum herformatteerd: ${value} -> ${newRow[header]}`);
        }
      }
    });
    
    return newRow;
  });
}

// IMPORT EXCEL
function handleFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  console.log('Excel bestand geselecteerd:', file.name);
  
  // Toon loading indicator
  loadingIndicator.style.display = 'block';
  document.getElementById('dataTable').style.display = 'none';

  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      console.log('Bestand gelezen, grootte:', e.target.result.byteLength, 'bytes');
      
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      
      console.log('Werkboek geladen, sheets:', workbook.SheetNames);
      
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      
      console.log('JSON data geladen, rijen:', json.length);
      console.log('Eerste 5 rijen:', json.slice(0, 5));

      // Zoek automatisch naar de header rij (rij met de meeste gevulde cellen)
      let headerRowIndex = 0;
      let maxFilledCells = 0;
      
      for (let i = 0; i < Math.min(10, json.length); i++) {
        const filledCells = json[i] ? json[i].filter(cell => cell !== undefined && cell !== null && cell !== '').length : 0;
        if (filledCells > maxFilledCells) {
          maxFilledCells = filledCells;
          headerRowIndex = i;
        }
      }
      
      console.log('Header rij gevonden op index:', headerRowIndex);
      
      const headers = json[headerRowIndex];
      console.log('Headers gevonden:', headers);
      
      if (!headers || headers.length === 0) {
        alert('Geen geldige headers gevonden in het Excel bestand');
        return;
      }

      // Data begint na de header rij
      const dataRows = json.slice(headerRowIndex + 1);
      console.log('Data rijen te verwerken:', dataRows.length);
      
      const rows = dataRows.map((row, index) => {
        let obj = {};
        headers.forEach((header, i) => {
          let value = row[i];
          
          // Datum parsing voor alle datum gerelateerde kolommen
          const dateKeywords = [
            'datum', 'date', 'transportdat', 'ophaal', 'aflevering', 
            'pickup', 'delivery', 'aanvraag', 'bev.', 'gepland'
          ];
          
          const isDateColumn = dateKeywords.some(keyword => 
            header.toLowerCase().includes(keyword.toLowerCase())
          );
          
          if (isDateColumn && value !== undefined && value !== null && value !== '') {
            console.log(`Verwerking datum voor kolom "${header}":`, value, typeof value);
            const dateObj = parseExcelDate(value);
            if (dateObj) {
              // Format naar Nederlandse notatie DD-MM-YYYY
              const formattedDate = formatDateDutch(dateObj);
              console.log(`Datum geformatteerd: ${value} -> ${formattedDate}`);
              value = formattedDate;
            } else {
              console.warn(`Kon datum niet parsen voor kolom "${header}":`, value);
            }
          }
          
          obj[header] = value ?? '';
        });
        
        // Filter uit lege rijen (rijen waar alle waarden leeg zijn)
        const hasData = Object.values(obj).some(val => val !== '');
        return hasData ? obj : null;
      }).filter(row => row !== null);

      console.log('Verwerkte rijen:', rows.length);
      
      if (rows.length === 0) {
        alert('Geen geldige data gevonden in het Excel bestand');
        return;
      }

      await mergeData(rows);
      currentData = [...allData];
      
      // Update beschikbare kolommen na nieuwe import
      if (allData.length > 0) {
        const newHeaders = Object.keys(allData[0]);
        
        // Voeg nieuwe kolommen toe aan availableColumns als ze er nog niet zijn
        newHeaders.forEach(header => {
          if (!availableColumns.includes(header)) {
            availableColumns.push(header);
          }
        });
        
        // Update originalColumnOrder met nieuwe kolommen
        if (originalColumnOrder.length === 0) {
          originalColumnOrder = [...newHeaders];
        } else {
          newHeaders.forEach(header => {
            if (!originalColumnOrder.includes(header)) {
              originalColumnOrder.push(header);
            }
          });
        }
      }
      
      renderTable(currentData);
      
      alert(`Succesvol ${rows.length} rijen geïmporteerd!`);
      
    } catch (error) {
      console.error('Fout bij verwerken van Excel bestand:', error);
      alert('Er is een fout opgetreden bij het importeren van het Excel bestand. Controleer de console voor details.');
    } finally {
      // Verberg loading indicator
      loadingIndicator.style.display = 'none';
      document.getElementById('dataTable').style.display = 'table';
      
      // Reset file input zodat hetzelfde bestand opnieuw geselecteerd kan worden
      fileInput.value = '';
    }
  };
  
  reader.onerror = function(error) {
    console.error('Fout bij lezen van bestand:', error);
    alert('Er is een fout opgetreden bij het lezen van het bestand.');
    // Verberg loading indicator bij fout
    loadingIndicator.style.display = 'none';
    document.getElementById('dataTable').style.display = 'table';
    fileInput.value = '';
  };
  
  reader.readAsArrayBuffer(file);
}

// FIREBASE FIRESTORE FUNCTIES
async function saveDataToFirestore(data) {
  if (!db) {
    console.error('Firebase database niet beschikbaar, gebruik localStorage als fallback');
    localStorage.setItem("dashboardData", JSON.stringify(data));
    return;
  }
  
  try {
    console.log('Opslaan naar Firestore, aantal items:', data.length);
    
    // Importeer benodigde Firestore functies dynamisch
    const { collection, doc, setDoc, getDocs, deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
    
    // Wis bestaande gegevens eerst
    console.log('Wissen van bestaande Firestore data...');
    const querySnapshot = await getDocs(collection(db, "dashboardData"));
    const deletePromises = querySnapshot.docs.map(document => deleteDoc(document.ref));
    await Promise.all(deletePromises);
    console.log('Bestaande data gewist');
    
    // Voeg nieuwe gegevens toe in batches om Firestore limieten te respecteren
    const batchSize = 500; // Firestore heeft een limiet van 500 operaties per batch
    
    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);
      const savePromises = batch.map((item, index) => {
        const docRef = doc(collection(db, "dashboardData"), `item_${i + index}`);
        return setDoc(docRef, item);
      });
      
      await Promise.all(savePromises);
      console.log(`Batch ${Math.floor(i/batchSize) + 1} opgeslagen (${batch.length} items)`);
    }
    
    console.log('Alle gegevens succesvol opgeslagen in Firestore');
  } catch (error) {
    console.error('Fout bij opslaan naar Firestore:', error);
    // Fallback naar localStorage
    console.log('Fallback naar localStorage...');
    localStorage.setItem("dashboardData", JSON.stringify(data));
  }
}

async function loadDataFromFirestore() {
  if (!db) {
    console.error('Firebase database niet beschikbaar');
    // Fallback naar localStorage
    const saved = JSON.parse(localStorage.getItem("dashboardData")) || [];
    allData = saved;
    
    // Herformatteer bestaande datums naar Nederlandse notatie
    if (allData.length > 0) {
      console.log('Herformatteren van bestaande datums (localStorage)...');
      allData = reformatExistingDates(allData);
    }
    
    currentData = [...allData];
    renderTable(currentData);
    return;
  }
  
  try {
    const { collection, getDocs } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
    
    const querySnapshot = await getDocs(collection(db, "dashboardData"));
    const loadedData = [];
    
    querySnapshot.forEach((doc) => {
      loadedData.push(doc.data());
    });
    
    allData = loadedData;
    
    // Herformatteer bestaande datums naar Nederlandse notatie
    if (allData.length > 0) {
      console.log('Herformatteren van bestaande datums...');
      allData = reformatExistingDates(allData);
    }
    
    currentData = [...allData];
    renderTable(currentData);
    console.log('Gegevens succesvol geladen uit Firestore');
  } catch (error) {
    console.error('Fout bij laden uit Firestore:', error);
    // Fallback naar localStorage
    const saved = JSON.parse(localStorage.getItem("dashboardData")) || [];
    allData = saved;
    
    // Herformatteer bestaande datums naar Nederlandse notatie
    if (allData.length > 0) {
      console.log('Herformatteren van bestaande datums (localStorage fallback)...');
      allData = reformatExistingDates(allData);
    }
    
    currentData = [...allData];
    renderTable(currentData);
  }
}

async function clearFirestoreData() {
  if (!db) {
    console.error('Firebase database niet beschikbaar');
    localStorage.removeItem('dashboardData');
    return;
  }
  
  try {
    const { collection, getDocs, deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
    
    const querySnapshot = await getDocs(collection(db, "dashboardData"));
    const deletePromises = querySnapshot.docs.map(document => deleteDoc(document.ref));
    await Promise.all(deletePromises);
    
    console.log('Alle gegevens succesvol gewist uit Firestore');
  } catch (error) {
    console.error('Fout bij wissen uit Firestore:', error);
    // Fallback naar localStorage
    localStorage.removeItem('dashboardData');
  }
}

// MERGE DATA
async function mergeData(newRows) {
  try {
    console.log('Merging data, nieuwe rijen:', newRows.length);
    
    const key = "Aanvraagnr.";
    
    // Controleer of de key kolom bestaat in de nieuwe data
    if (newRows.length > 0 && !newRows[0].hasOwnProperty(key)) {
      console.warn(`Waarschuwing: Kolom "${key}" niet gevonden in de data. Beschikbare kolommen:`, Object.keys(newRows[0]));
      // Probeer alternatieve keys
      const possibleKeys = ["Aanvraagnummer", "Aanvraag nummer", "Aanvraag nr", "Aanvraagnr"];
      let foundKey = null;
      for (const possibleKey of possibleKeys) {
        if (newRows[0].hasOwnProperty(possibleKey)) {
          foundKey = possibleKey;
          break;
        }
      }
      
      if (foundKey) {
        console.log(`Alternatieve key gevonden: "${foundKey}"`);
        // Hernoem de kolom naar de verwachte key
        newRows.forEach(row => {
          row[key] = row[foundKey];
        });
      } else {
        console.warn('Geen geschikte key kolom gevonden, alle rijen worden toegevoegd');
      }
    }
    
    // Gebruik de al geladen allData array in plaats van localStorage
    const existing = [...allData];
    console.log('Bestaande rijen:', existing.length);
    
    const combined = [...existing];
    let addedCount = 0;
    
    newRows.forEach(row => {
      // Als er geen key is, voeg gewoon toe
      if (!row[key] || !combined.some(item => item[key] === row[key])) {
        combined.push(row);
        addedCount++;
      }
    });

    console.log('Nieuwe rijen toegevoegd:', addedCount);
    console.log('Totaal rijen na merge:', combined.length);

    allData = combined;
    
    // Sla op naar Firestore in plaats van localStorage
    await saveDataToFirestore(allData);
    
    // Behoud localStorage als backup
    localStorage.setItem("dashboardData", JSON.stringify(allData));
    
    console.log('Data succesvol opgeslagen');
    
  } catch (error) {
    console.error('Fout bij mergen van data:', error);
    throw error; // Gooi de fout door zodat de handleFile functie het kan afhandelen
  }
}

// RENDER TABEL
function renderTable(data) {
  tableHead.innerHTML = '';
  tableBody.innerHTML = '';
  if (data.length === 0) return;

  const originalHeaders = Object.keys(data[0]);
  
  // Update beschikbare kolommen voor kolom beheer
  if (availableColumns.length === 0) {
    availableColumns = [...originalHeaders];
    originalColumnOrder = [...originalHeaders]; // Sla oorspronkelijke volgorde op
    loadHiddenColumns(); // Laad opgeslagen verborgen kolommen en volgorde
  }
  
  // Gebruik aangepaste volgorde of val terug op originele volgorde
  let headers;
  if (columnOrder.length > 0) {
    // Filter columnOrder om alleen bestaande kolommen te behouden en voeg nieuwe toe
    const existingOrderedCols = columnOrder.filter(col => originalHeaders.includes(col));
    const newCols = originalHeaders.filter(col => !columnOrder.includes(col));
    headers = [...existingOrderedCols, ...newCols];
  } else {
    headers = originalHeaders;
  }
  
  const headerRow = document.createElement('tr');

  const alphaColumns = ["Afvalstof"];
  
  // Automatische detectie van datum kolommen
  const dateKeywords = [
    'datum', 'date', 'transportdat', 'ophaal', 'aflevering', 
    'pickup', 'delivery', 'aanvraag', 'bev.', 'gepland'
  ];
  
  const dateColumns = headers.filter(header => 
    dateKeywords.some(keyword => 
      header.toLowerCase().includes(keyword.toLowerCase())
    )
  );

  headers.forEach((header, index) => {
    const th = document.createElement('th');
    th.textContent = header;
    
    // Voeg CSS klasse toe voor verborgen kolommen
    if (hiddenColumns.has(header)) {
      th.classList.add('hidden-column');
    }

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

  data.forEach((row, index) => {
    const tr = document.createElement('tr');
    
    // Voeg double-click event toe aan de rij
    tr.addEventListener('dblclick', () => {
      showRowDetails(row, index);
    });
    
    // Voeg title toe voor hover hint
    tr.title = 'Dubbel klik om alle details te bekijken';
    
    headers.forEach(header => {
      const td = document.createElement('td');
      td.textContent = row[header];
      
      // Voeg CSS klasse toe voor verborgen kolommen
      if (hiddenColumns.has(header)) {
        td.classList.add('hidden-column');
      }
      
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
  
  // Automatische detectie van datum kolommen
  const dateKeywords = [
    'datum', 'date', 'transportdat', 'ophaal', 'aflevering', 
    'pickup', 'delivery', 'aanvraag', 'bev.', 'gepland'
  ];
  
  const isDateColumn = dateKeywords.some(keyword => 
    column.toLowerCase().includes(keyword.toLowerCase())
  );

  if (!alphaColumns.includes(column) && !isDateColumn) return;

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

    if (isDateColumn) {
      // Parse Nederlandse datum notatie (DD-MM-YYYY) voor sorting
      const parseDate = (dateStr) => {
        if (!dateStr) return new Date(0);
        const parts = dateStr.split('-');
        if (parts.length === 3) {
          const [day, month, year] = parts;
          return new Date(year, month - 1, day);
        }
        return parseExcelDate(dateStr) || new Date(0);
      };
      
      const timeA = parseDate(valA).getTime();
      const timeB = parseDate(valB).getTime();
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

// KOLOM BEHEER FUNCTIES
function showColumnManagementModal() {
  // Bouw de checkbox lijst op met de huidige volgorde
  columnCheckboxes.innerHTML = '';
  
  // Gebruik de opgeslagen volgorde of de beschikbare kolommen als fallback
  const orderedColumns = columnOrder.length > 0 ? columnOrder : availableColumns;
  
  orderedColumns.forEach((column, index) => {
    const checkboxItem = document.createElement('div');
    checkboxItem.className = 'column-checkbox-item';
    checkboxItem.draggable = true;
    checkboxItem.dataset.column = column;
    checkboxItem.dataset.index = index;
    
    // Drag handle
    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.innerHTML = '⋮⋮';
    dragHandle.title = 'Sleep om volgorde te wijzigen';
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `col-${column}`;
    checkbox.value = column;
    checkbox.checked = !hiddenColumns.has(column);
    
    const label = document.createElement('label');
    label.htmlFor = `col-${column}`;
    label.textContent = column;
    label.style.flexGrow = '1';
    
    checkboxItem.appendChild(dragHandle);
    checkboxItem.appendChild(checkbox);
    checkboxItem.appendChild(label);
    
    // Voeg drag event listeners toe
    addDragEventListeners(checkboxItem);
    
    columnCheckboxes.appendChild(checkboxItem);
  });
  
  // Toon de modal
  columnModal.style.display = "block";
  columnModalOverlay.style.display = "block";
}

function addDragEventListeners(item) {
  item.addEventListener('dragstart', handleDragStart);
  item.addEventListener('dragover', handleDragOver);
  item.addEventListener('dragenter', handleDragEnter);
  item.addEventListener('dragleave', handleDragLeave);
  item.addEventListener('drop', handleDrop);
  item.addEventListener('dragend', handleDragEnd);
}

let draggedItem = null;

function handleDragStart(e) {
  draggedItem = e.target;
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/html', e.target.outerHTML);
}

function handleDragOver(e) {
  if (e.preventDefault) {
    e.preventDefault();
  }
  e.dataTransfer.dropEffect = 'move';
  return false;
}

function handleDragEnter(e) {
  e.target.classList.add('drag-over');
}

function handleDragLeave(e) {
  e.target.classList.remove('drag-over');
}

function handleDrop(e) {
  if (e.stopPropagation) {
    e.stopPropagation();
  }
  
  const dropTarget = e.target.closest('.column-checkbox-item');
  
  if (draggedItem !== dropTarget) {
    // Verplaats het element in de DOM
    const parent = dropTarget.parentNode;
    const allItems = [...parent.children];
    const draggedIndex = allItems.indexOf(draggedItem);
    const targetIndex = allItems.indexOf(dropTarget);
    
    if (draggedIndex < targetIndex) {
      parent.insertBefore(draggedItem, dropTarget.nextSibling);
    } else {
      parent.insertBefore(draggedItem, dropTarget);
    }
  }
  
  dropTarget.classList.remove('drag-over');
  return false;
}

function handleDragEnd(e) {
  e.target.classList.remove('dragging');
  
  // Verwijder alle drag-over klassen
  const items = columnCheckboxes.querySelectorAll('.column-checkbox-item');
  items.forEach(item => item.classList.remove('drag-over'));
}

function updateColumnOrder() {
  const items = columnCheckboxes.querySelectorAll('.column-checkbox-item');
  columnOrder = Array.from(items).map(item => item.dataset.column);
  
  // Sla kolom volgorde op in localStorage
  localStorage.setItem('columnOrder', JSON.stringify(columnOrder));
  
  console.log('Kolom volgorde bijgewerkt:', columnOrder);
}

function loadColumnOrder() {
  try {
    const saved = localStorage.getItem('columnOrder');
    if (saved) {
      columnOrder = JSON.parse(saved);
      console.log('Kolom volgorde geladen:', columnOrder);
    }
  } catch (error) {
    console.error('Fout bij laden kolom volgorde:', error);
    columnOrder = [];
  }
}

function updateHiddenColumns() {
  const checkboxes = columnCheckboxes.querySelectorAll('input[type="checkbox"]');
  hiddenColumns.clear();
  
  checkboxes.forEach(cb => {
    if (!cb.checked) {
      hiddenColumns.add(cb.value);
    }
  });
  
  // Sla verborgen kolommen op in localStorage
  localStorage.setItem('hiddenColumns', JSON.stringify([...hiddenColumns]));
  
  console.log('Verborgen kolommen bijgewerkt:', [...hiddenColumns]);
}

function loadHiddenColumns() {
  try {
    const saved = localStorage.getItem('hiddenColumns');
    if (saved) {
      hiddenColumns = new Set(JSON.parse(saved));
      console.log('Verborgen kolommen geladen:', [...hiddenColumns]);
    }
  } catch (error) {
    console.error('Fout bij laden verborgen kolommen:', error);
    hiddenColumns = new Set();
  }
  
  // Laad ook de kolom volgorde
  loadColumnOrder();
}

// RIJ DETAIL FUNCTIES
function showRowDetails(rowData, rowIndex) {
  // Set titel
  const aanvraagNr = rowData['Aanvraagnr.'] || rowData['Aanvraagnummer'] || `Rij ${rowIndex + 1}`;
  rowDetailTitle.textContent = `Details - ${aanvraagNr}`;
  
  // Bouw content
  rowDetailContent.innerHTML = '';
  
  // Gebruik de kolom volgorde als die beschikbaar is
  const orderedColumns = columnOrder.length > 0 ? columnOrder : Object.keys(rowData);
  
  orderedColumns.forEach(key => {
    if (rowData.hasOwnProperty(key)) {
      const detailItem = document.createElement('div');
      detailItem.className = 'detail-item';
      
      const label = document.createElement('div');
      label.className = 'detail-label';
      label.textContent = key + ':';
      
      const value = document.createElement('div');
      value.className = 'detail-value';
      
      const cellValue = rowData[key];
      if (cellValue === undefined || cellValue === null || cellValue === '') {
        value.textContent = '(leeg)';
        value.classList.add('empty');
      } else {
        value.textContent = cellValue;
      }
      
      detailItem.appendChild(label);
      detailItem.appendChild(value);
      rowDetailContent.appendChild(detailItem);
    }
  });
  
  // Toon modal
  rowDetailModal.style.display = "block";
  rowDetailModalOverlay.style.display = "block";
}

// Opmerking: Gegevens laden gebeurt nu via loadDataFromFirestore() in de window load event
