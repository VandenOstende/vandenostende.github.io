# DataTracking - GPX Fietsrit Tracker

DataTracking is een complete webtoepassing suite voor het bijhouden, analyseren en visualiseren van fietsritten. De applicatie bestaat uit drie hoofdcomponenten die samen een krachtig platform vormen voor fietsers om hun routes en prestaties te volgen.

## 📋 Overzicht

De DataTracking app biedt de volgende functionaliteit:
- **Real-time rit tracking** met GPS-locatie
- **GPX-bestand beheer** voor opgeslagen ritten
- **Interactieve kaarten** met route visualisatie
- **Statistieken en analyses** van je fietsritten
- **Weersomstandigheden** registratie per rit

## 🗺️ Componenten

### 1. Dashboard (dashboard.html)

Het centrale dashboard biedt een overzicht van al je fietsactiviteiten en snelle toegang tot de verschillende functies.

![Dashboard](https://github.com/user-attachments/assets/cb2e0d4f-c09a-4c1a-8e0d-ce26b0406c12)

**Functies:**
- **Kilometeroverzicht**: Bekijk je afgelegde kilometers per dag, week, maand of jaar
- **Grafiekweergave**: Kies tussen lijn- en staafgrafieken voor datavisualisatie
- **Periodiekeuze**: Filter je ritten op specifieke periodes (dag/week/maand/jaar)
- **Snelkoppelingen**: Directe toegang naar:
  - Rit Tracker - Start een nieuwe rit
  - Ritten & Kaart - Bekijk en beheer je ritten
  - Nieuwe GPX toevoegen - Upload een bestaand GPX-bestand

**Gebruik:**
1. Open `dashboard.html` om je overzicht te zien
2. Selecteer de gewenste periode (Dag/Week/Maand/Jaar)
3. Kies het grafiektype (Lijn/Staaf)
4. Gebruik de snelkoppelingen om naar andere functies te navigeren

---

### 2. Rit Tracker (RideTracker.html)

De Rit Tracker is een full-screen, mobielvriendelijke applicatie voor het in real-time opnemen van fietsritten.

![Rit Tracker](https://github.com/user-attachments/assets/16b580b8-67db-45c1-bd14-9e05dcea5799)

**Functies:**
- **Real-time GPS tracking**: Volg je route live op een interactieve kaart
- **Live metrics**: Zie direct je statistieken tijdens het fietsen
  - **Afstand**: Totaal afgelegde kilometers
  - **Snelheid**: Huidige snelheid in km/u
  - **Gemiddelde**: Gemiddelde snelheid
  - **Hoogte**: Huidige hoogte in meters
- **GPX-export**: Download je rit als GPX-bestand
- **Firebase-integratie**: Optioneel importeren naar GPXTracker
- **Volledig scherm**: Optimaal voor gebruik tijdens het fietsen
- **Mobile-first design**: Perfect te gebruiken op smartphone

**Gebruik:**
1. Open `RideTracker.html` op je telefoon of computer
2. Geef toestemming voor locatietoegang wanneer gevraagd
3. Klik op "Start rit" om je rit te beginnen
4. Fiets je route - de app volgt automatisch je locatie
5. Klik op "Stop rit" wanneer je klaar bent
6. Kies om de GPX te downloaden of te importeren in GPXTracker

**Technische details:**
- Gebruikt Mapbox GL JS voor kaartweergave
- Geolocation API voor GPS-tracking
- Berekent automatisch afstand, snelheid en hoogte
- Genereert standaard GPX 1.1 formaat

---

### 3. GPX Tracker Dashboard (GPXTracker.html)

De GPX Tracker is een uitgebreide tool voor het beheren, visualiseren en analyseren van je opgeslagen fietsritten.

![GPX Tracker Dashboard](https://github.com/user-attachments/assets/bcd4e8b8-1e7c-4503-ae59-f2bb9746bd64)

**Functies:**
- **GPX-upload**: Importeer GPX-bestanden van je ritten
- **Interactieve kaart**: Bekijk routes op een Mapbox kaart
- **Rittenlijst**: Overzicht van al je opgeslagen ritten met sorteermogelijkheden:
  - Datum (nieuwste/oudste eerst)
  - Weersomstandigheden (A-Z)
  - Maximum snelheid (hoog-laag of laag-hoog)
- **Trackdetails**: Gedetailleerde informatie over geselecteerde ritten:
  - Datum van de rit
  - Weersomstandigheden (Regen/Sneeuw/Zon)
  - Routevisualisatie op kaart
- **Statistieken**: Uitgebreide analyses van je ritten:
  - Totale afstand
  - Maximum snelheid
  - Gemiddelde snelheid
  - Hoogteverschillen
- **Rittenbeheer**: Verwijder ritten uit je collectie
- **Firebase-opslag**: Cloud-gebaseerde opslag voor je ritten

**Gebruik:**
1. Open `GPXTracker.html` in je browser
2. Klik op "Fietsrit toevoegen" om een nieuwe rit toe te voegen
3. Upload een GPX-bestand via het dialoogvenster
4. Vul de datum en weersomstandigheden in
5. Klik op "Opslaan" - de rit verschijnt in de lijst
6. Klik op een rit in de lijst om deze op de kaart te bekijken
7. Gebruik "Verwijderen" om een geselecteerde rit te verwijderen
8. Sorteer je ritten met het dropdown-menu

**Modal dialoog voor nieuwe rit:**
- **GPX-bestand**: Upload een .gpx bestand
- **Datum**: Wordt automatisch ingevuld uit het GPX-bestand
- **Weersomstandigheden**: Kies tussen Regen, Sneeuw of Zon
- **Validatie**: Controleert of alle velden correct zijn ingevuld

---

## 🔧 Technische Architectuur

### Dependencies

De applicatie maakt gebruik van de volgende libraries en services:

- **Mapbox GL JS v3.1.2**: Interactieve kaartweergave
- **Firebase v10.12.2**: Cloud database en authenticatie
  - firebase-app-compat.js
  - firebase-auth-compat.js
  - firebase-firestore-compat.js
- **Chart.js v4.4.1**: Grafiekvisualisaties (dashboard)
- **togeojson v0.16.0**: Conversie van GPX naar GeoJSON

### Bestandsstructuur

```
DataTracking/
├── dashboard.html          # Hoofddashboard met statistieken
├── dashboard.js            # Dashboard logica en Chart.js integratie
├── RideTracker.html        # Real-time rit tracker
├── ride-tracker.js         # GPS tracking en GPX generatie
├── GPXTracker.html         # GPX beheer en visualisatie
├── main.js                 # GPXTracker hoofdlogica
├── script.js               # Gedeelde utility functies
├── style.css               # Gemeenschappelijke stijlen
└── README.md              # Deze documentatie
```

### Firebase Configuratie

De app gebruikt Firebase voor:
- **Firestore Database**: Opslag van rittengegevens
- **Authentication**: Gebruikersauthenticatie (optioneel)
- **Cloud Storage**: GPX-bestand opslag

Firebase configuratie is ingebouwd in de HTML-bestanden (`FIREBASE_CONFIG`).

### Mapbox Configuratie

De app gebruikt Mapbox voor kaartweergave met de access token `MAPBOX_ACCESS_TOKEN` die is ingesteld in de HTML-bestanden.

---

## 🚀 Aan de slag

### Vereisten

- Moderne webbrowser (Chrome, Firefox, Safari, Edge)
- Internetverbinding voor kaarten en Firebase
- GPS/locatieservices voor Rit Tracker
- Optioneel: Firebase account voor cloud-opslag

### Installatie

Deze applicatie is volledig client-side en vereist geen installatie. Gewoon de HTML-bestanden openen in een browser.

1. Open `dashboard.html` als startpunt
2. Gebruik de snelkoppelingen om te navigeren naar de andere componenten
3. Voor productiegebruik: host de bestanden op een webserver of GitHub Pages

### Eerste gebruik

1. **Start met het Dashboard**: Open `dashboard.html` om een overzicht te krijgen
2. **Neem je eerste rit op**: Klik op "Start Rit Tracker" en begin met fietsen
3. **Upload bestaande ritten**: Gebruik "Nieuwe GPX toevoegen" om oude ritten te importeren
4. **Bekijk je voortgang**: Analyseer je statistieken en routes op het dashboard

---

## 📱 Mobiele Ervaring

De applicatie is volledig geoptimaliseerd voor mobiel gebruik:

- **Responsive design**: Werkt perfect op smartphones, tablets en desktops
- **Touch-optimized**: Grote knoppen en touch-vriendelijke interfaces
- **Safe area support**: Respecteert notches en randen van moderne smartphones
- **Full-screen mode**: Rit Tracker gebruikt het volledige scherm voor optimaal zicht
- **Offline-ready**: Basis functionaliteit werkt zonder internetverbinding

### Aanbevolen gebruik op mobiel:
- Gebruik Rit Tracker voor het opnemen van ritten tijdens het fietsen
- Monteer je telefoon veilig op je stuur
- Zorg voor voldoende batterij of gebruik een powerbank
- Download ritten voor offline gebruik

---

## 🔒 Privacy & Beveiliging

- Locatiegegevens worden alleen lokaal verwerkt tijdens het tracken
- Firebase-opslag is beveiligd met authenticatie (indien geconfigureerd)
- GPX-bestanden kunnen lokaal worden gedownload en opgeslagen
- Geen tracking of analytics buiten Firebase om

---

## 🐛 Bekende Beperkingen

- Firebase SDK vereist internetverbinding
- Mapbox kaarten vereisen internetverbinding
- GPS-nauwkeurigheid is afhankelijk van je apparaat en omgeving
- Batterijverbruik kan hoog zijn bij langdurig GPS-gebruik

---

## 🤝 Support & Bijdragen

Voor vragen, bugs of feature requests, neem contact op via het hoofdproject.

---

## 📄 Licentie

Dit project maakt deel uit van de vandenostende.github.io website.
