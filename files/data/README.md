# Supermarket Locations Datasets

## Overview

This directory contains comprehensive JSON datasets of supermarket locations across Belgium.

## Available Datasets

1. **SPAR Belgium** - SPAR and SPAR Express locations across Belgium
2. **ALDI Flanders** - ALDI supermarket locations in Flanders (Vlaanderen)

## Files

- `spar-belgium-locations.json` - SPAR store locations across Belgium (28 stores)
- `aldi-flanders-locations.json` - ALDI store locations in Flanders (30 stores)

## Dataset Information

### SPAR Belgium Dataset
- **Total SPAR stores in Belgium**: 335 (as of 2025)
- **Stores in this dataset**: 28 representative locations
- **Regions covered**: 
  - Flanders: 15 stores
  - Wallonia: 12 stores
  - Brussels: 1 store

### ALDI Flanders Dataset
- **Total ALDI stores in Belgium**: 450+ (as of 2025)
- **Total ALDI stores in Flanders**: 289
- **Stores in this dataset**: 30 representative locations
- **Provinces covered**:
  - East Flanders: 14 stores
  - West Flanders: 6 stores
  - Flemish Brabant: 4 stores
  - Antwerp: 3 stores
  - Limburg: 3 stores

### Data Structure

The JSON file contains:

#### Metadata Section
```json
{
  "metadata": {
    "title": "Title of the dataset",
    "description": "Description",
    "country": "Belgium",
    "total_stores": 335,
    "regions": { ... },
    "last_updated": "2025-12-29",
    "data_source": "Source information",
    "stores_in_dataset": 28
  }
}
```

#### Store Entry Structure
Each store includes:

```json
{
  "id": "unique-store-identifier",
  "name": "Store Name",
  "type": "SPAR | SPAR Express | Eurospar",
  "address": {
    "street": "Street and number",
    "city": "City name",
    "postal_code": "Postal code",
    "province": "Province name",
    "region": "Flanders | Wallonia | Brussels",
    "country": "Belgium"
  },
  "coordinates": {
    "latitude": 50.1234,
    "longitude": 4.5678
  },
  "contact": {
    "phone": "+32 XX XXX XX XX",
    "website": "https://www.spar.be/..."
  },
  "features": {
    "wheelchair_accessible": true,
    "parking": true
  }
}
```

## Usage Examples

### JavaScript - SPAR Dataset
```javascript
// Fetch and use the SPAR data
fetch('/files/data/spar-belgium-locations.json')
  .then(response => response.json())
  .then(data => {
    console.log(`Total stores: ${data.metadata.total_stores}`);
    data.stores.forEach(store => {
      console.log(`${store.name} - ${store.address.city}`);
    });
  });
```

### JavaScript - ALDI Dataset
```javascript
// Fetch and use the ALDI data
fetch('/files/data/aldi-flanders-locations.json')
  .then(response => response.json())
  .then(data => {
    console.log(`Total stores in Flanders: ${data.metadata.total_stores_flanders}`);
    data.stores.forEach(store => {
      console.log(`${store.name} - ${store.address.city}`);
    });
  });
```

### Python
```python
import json

with open('spar-belgium-locations.json', 'r') as f:
    data = json.load(f)
    
print(f"Total stores: {data['metadata']['total_stores']}")
for store in data['stores']:
    print(f"{store['name']} - {store['address']['city']}")
```

### Filtering Examples

**Find stores in Flanders:**
```javascript
const flandersStores = data.stores.filter(
  store => store.address.region === 'Flanders'
);
```

**Find stores in a specific city:**
```javascript
const leuvenStores = data.stores.filter(
  store => store.address.city === 'Leuven'
);
```

**Find wheelchair accessible stores:**
```javascript
const accessibleStores = data.stores.filter(
  store => store.features.wheelchair_accessible === true
);
```

## Data Sources

### SPAR Dataset
Compiled from publicly available information including:
- SPAR Belgium official website (spar.be, mijnspar.be, monspar.be)
- Tiendeo store directories
- Various Belgian retail directories
- Store opening hours websites

### ALDI Dataset
Compiled from publicly available information including:
- ALDI Belgium official website (aldi.be)
- Hours.be and Openingsuren.Vlaanderen
- Various Belgian retail directories
- Store locator services

## Complete Datasets

These files contain representative locations. For complete datasets:

### SPAR (all 335 locations in Belgium)
- [Geolocet - SPAR Belgium](https://geolocet.com/products/belgium-spar-grocery)
- [POIdata.io - SPAR Belgium](https://poidata.io/brand-report/spar/belgium)
- [RetailStat - SPAR Belgium](https://store.retailstat.com/)

### ALDI (all 450+ locations in Belgium)
- [Geolocet - ALDI Belgium](https://geolocet.com/products/belgium-aldi-grocery)
- [FranchiseData - ALDI Belgium](https://www.franchisedata.org/aldi/BE)
- [RetailStat - ALDI Belgium](https://store.retailstat.com/)

## License

This dataset is provided for informational purposes. Please verify store information with official SPAR Belgium sources before using for commercial purposes.

## Updates

Last updated: December 29, 2025

For the most current store information, visit:

**SPAR:**
- [SPAR Belgium Store Locator](https://www.spar.be/winkels)
- [Mijn SPAR](https://www.mijnspar.be/winkels)
- [Mon SPAR](https://www.monspar.be/magasins)

**ALDI:**
- [ALDI Belgium Store Locator](https://www.aldi.be/nl/informatie/supermarkten.html)
