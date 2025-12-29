# SPAR Belgium Locations Dataset

## Overview

This directory contains a comprehensive JSON dataset of SPAR supermarket locations across Belgium.

## Files

- `spar-belgium-locations.json` - Main dataset file containing SPAR store locations

## Dataset Information

### Coverage
- **Total SPAR stores in Belgium**: 335 (as of 2025)
- **Stores in this dataset**: 28 representative locations
- **Regions covered**: 
  - Flanders: 15 stores
  - Wallonia: 12 stores
  - Brussels: 1 store

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

### JavaScript
```javascript
// Fetch and use the data
fetch('/files/data/spar-belgium-locations.json')
  .then(response => response.json())
  .then(data => {
    console.log(`Total stores: ${data.metadata.total_stores}`);
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

This dataset was compiled from publicly available information including:
- SPAR Belgium official website (spar.be, mijnspar.be, monspar.be)
- Tiendeo store directories
- Various Belgian retail directories
- Store opening hours websites

## Complete Dataset

This file contains 28 representative SPAR locations across Belgium. For the complete dataset with all 335 SPAR locations including:
- All store addresses
- Detailed opening hours
- Additional store features
- Business ratings

Consider purchasing comprehensive datasets from:
- [Geolocet](https://geolocet.com/products/belgium-spar-grocery)
- [POIdata.io](https://poidata.io/brand-report/spar/belgium)
- [RetailStat](https://store.retailstat.com/)

## License

This dataset is provided for informational purposes. Please verify store information with official SPAR Belgium sources before using for commercial purposes.

## Updates

Last updated: December 29, 2025

For the most current store information, visit:
- [SPAR Belgium Store Locator](https://www.spar.be/winkels)
- [Mijn SPAR](https://www.mijnspar.be/winkels)
- [Mon SPAR](https://www.monspar.be/magasins)
