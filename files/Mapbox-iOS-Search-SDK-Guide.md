# Mapbox iOS Search SDK - Complete Documentation Guide

> **Version:** Search SDK v2.x  
> **Last Updated:** November 2025  
> **Platform:** iOS 12.0+  
> **Language:** Swift 5.9+

---

## 🔗 Snelkoppelingen (Quick Navigation)

| 📚 Basis | 🛠️ Implementatie | 🎨 Aanpassing | 🔧 Geavanceerd | 📖 Referentie |
|----------|------------------|---------------|----------------|---------------|
| [Overview](#overview) | [Quick Start](#quick-start-guide) | [SearchController Customization](#searchcontroller-customization) | [SwiftUI Integration](#swiftui-integration) | [API Reference](#api-reference) |
| [Features](#features) | [SearchController](#searchcontroller-drop-in-ui) | [Custom Search Bar](#custom-search-bar) | [Maps SDK Integration](#maps-sdk-integration) | [Troubleshooting](#troubleshooting) |
| [Requirements](#requirements) | [Forward Geocoding](#forward-geocoding) | [Result Filtering](#result-filtering) | [Search History & Favorites](#search-history--favorites) | [Resources](#resources) |
| [Installation](#installation) | [Reverse Geocoding](#reverse-geocoding) | [Proximity Biasing](#proximity-biasing) | [Offline Search](#offline-search) | |
| [Configuration](#configuration) | [Place Autocomplete](#place-autocomplete) | [Language Configuration](#language-configuration) | | |
| | [Category Search](#category-search-discover) | | | |

---

## 📑 Inhoudsopgave (Table of Contents)

| # | Hoofdstuk | Beschrijving |
|---|-----------|--------------|
| 1 | [Overview](#overview) | Introductie tot de Search SDK en mogelijkheden |
| 2 | [Features](#features) | Zoekfunctionaliteiten en kernmogelijkheden |
| 3 | [Requirements](#requirements) | SDK vereisten (Swift, Xcode, iOS) |
| 4 | [Installation](#installation) | Swift Package Manager en CocoaPods setup |
| 5 | [Configuration](#configuration) | Access tokens en Info.plist configuratie |
| 6 | [Quick Start Guide](#quick-start-guide) | Snelle start met code voorbeelden |
| 7 | [SearchController (Drop-in UI)](#searchcontroller-drop-in-ui) | Kant-en-klare zoek UI |
| 8 | [Forward Geocoding](#forward-geocoding) | Adres naar coördinaten conversie |
| 9 | [Reverse Geocoding](#reverse-geocoding) | Coördinaten naar adres conversie |
| 10 | [Place Autocomplete](#place-autocomplete) | Automatische suggesties tijdens typen |
| 11 | [Category Search (Discover)](#category-search-discover) | POI zoeken op categorie |
| 12 | [SearchController Customization](#searchcontroller-customization) | Aanpassing van de zoek interface |
| 13 | [Custom Search Bar](#custom-search-bar) | Eigen zoekbalk implementatie |
| 14 | [Result Filtering](#result-filtering) | Filteren van zoekresultaten |
| 15 | [Proximity Biasing](#proximity-biasing) | Locatiegebaseerde zoekresultaten |
| 16 | [Language Configuration](#language-configuration) | Taalinstellingen voor resultaten |
| 17 | [SwiftUI Integration](#swiftui-integration) | SwiftUI wrapper implementatie |
| 18 | [Maps SDK Integration](#maps-sdk-integration) | Integratie met Mapbox Maps |
| 19 | [Search History & Favorites](#search-history--favorites) | Zoekgeschiedenis en favorieten |
| 20 | [Offline Search](#offline-search) | Offline zoekfunctionaliteit |
| 21 | [API Reference](#api-reference) | Core klassen en methoden |
| 22 | [Troubleshooting](#troubleshooting) | Veelvoorkomende problemen |
| 23 | [Resources](#resources) | Officiële documentatie en links |

---

## 🔗 Gerelateerde Documentatie

| Document | Beschrijving |
|----------|--------------|
| [📍 Mapbox iOS Navigation SDK Guide](Mapbox-iOS-Navigation-SDK-Guide.md) | Turn-by-turn navigatie, route berekening, CarPlay |

---

## Overview

The **Mapbox Search SDK for iOS** provides powerful location search capabilities for your iOS applications. It enables address autocomplete, place search, reverse geocoding, and category-based POI discovery using Mapbox's global search infrastructure.

### Key Highlights

- 🔍 **Address Autocomplete** - Real-time suggestions as users type
- 📍 **Forward Geocoding** - Convert addresses to coordinates
- 🗺️ **Reverse Geocoding** - Convert coordinates to addresses
- 🏪 **Category Search** - Find POIs by category (restaurants, hotels, etc.)
- 🎨 **Drop-in UI** - Ready-to-use SearchController component
- ⚡ **Place Autocomplete** - Smart place suggestions with detailed results
- 📱 **SwiftUI Support** - UIKit wrapper for SwiftUI integration
- 🌍 **Multi-language** - Results in user's preferred language

---

## Features

### SDK Components

| Component | Description |
|-----------|-------------|
| **MapboxSearch** | Core search library with SearchEngine, PlaceAutocomplete, Discover |
| **MapboxSearchUI** | Pre-built UI components (SearchController, SearchBar) |

### Search Capabilities

- **Text Search** - Full-text search for addresses and places
- **Autocomplete** - Real-time suggestions while typing
- **Category Search** - POI discovery by category
- **Reverse Geocoding** - Location lookup by coordinates
- **Search History** - Local storage of recent searches
- **Favorites** - Save and retrieve favorite locations
- **Offline Mode** - Limited offline search capabilities

---

## Requirements

### SDK Requirements

| Requirement | Minimum Version |
|-------------|-----------------|
| **Swift** | 5.9+ |
| **Xcode** | 16.0+ |
| **iOS** | 12.0+ |

---

## Installation

### Step 1: Create Mapbox Access Tokens

You need **two types of tokens**:

#### Public Token (for Runtime API Access)
- Default token from your Mapbox dashboard
- Used for API calls at runtime
- Added to Info.plist

#### Secret Token (for SDK Download)
- Token with `DOWNLOADS:READ` scope
- Used only during installation
- Stored in `.netrc` file

### Step 2: Configure .netrc File

Create or edit `~/.netrc` in your home directory:

```bash
# On your macOS terminal:
cd ~
touch .netrc
open .netrc
```

Add this content:

```
machine api.mapbox.com
login mapbox
password YOUR_SECRET_ACCESS_TOKEN
```

> ⚠️ **Important:** Never commit your secret token to source control!

### Step 3: Install via Swift Package Manager

#### Using Xcode UI:

1. Open your project in Xcode
2. Go to **File → Add Packages…**
3. Enter the repository URL:
   ```
   https://github.com/mapbox/mapbox-search-ios.git
   ```
4. Select either:
   - `MapboxSearch` - Core library only
   - `MapboxSearchUI` - Core + UI components
5. Click **Add Package**

#### Using Package.swift:

```swift
dependencies: [
    .package(
        url: "https://github.com/mapbox/mapbox-search-ios.git",
        from: "2.0.0"
    )
]
```

### Step 4: Install via CocoaPods (Alternative)

Add to your `Podfile`:

```ruby
pod 'MapboxSearchUI', '>= 1.0.0-beta.39', '< 2.0'
```

Then run:

```bash
pod install
```

---

## Configuration

### Add Public Token to Info.plist

Add your public Mapbox access token to your app's `Info.plist`:

```xml
<key>MBXAccessToken</key>
<string>YOUR_PUBLIC_MAPBOX_ACCESS_TOKEN</string>
```

### Alternative: Set Token Programmatically

```swift
import MapboxSearch

// Set access token before using any search functionality
MapboxOptions.accessToken = "YOUR_PUBLIC_MAPBOX_ACCESS_TOKEN"
```

---

## Quick Start Guide

### Basic Search Implementation

```swift
import UIKit
import MapboxSearch
import MapboxSearchUI

class SearchViewController: UIViewController {
    
    // MARK: - Properties
    
    let searchController = SearchController()
    
    // MARK: - Lifecycle
    
    override func viewDidLoad() {
        super.viewDidLoad()
        setupSearch()
    }
    
    // MARK: - Setup
    
    private func setupSearch() {
        searchController.delegate = self
    }
    
    // MARK: - Actions
    
    @IBAction func showSearchTapped(_ sender: Any) {
        present(searchController, animated: true)
    }
}

// MARK: - SearchControllerDelegate

extension SearchViewController: SearchControllerDelegate {
    
    func searchResultSelected(_ searchResult: SearchResult) {
        print("Selected: \(searchResult.name)")
        print("Coordinates: \(searchResult.coordinate)")
        print("Address: \(searchResult.address?.formattedAddress(style: .full) ?? "N/A")")
        
        dismiss(animated: true)
    }
    
    func categorySearchResultsReceived(results: [SearchResult]) {
        print("Category results: \(results.count)")
    }
    
    func userFavoriteSelected(_ favorite: FavoriteRecord) {
        print("Favorite selected: \(favorite.name)")
    }
}
```

---

## SearchController (Drop-in UI)

The `SearchController` provides a complete, ready-to-use search interface with:
- Search bar with autocomplete
- Category shortcuts
- Recent searches
- Favorites support

### Basic Usage

```swift
import MapboxSearchUI

class ViewController: UIViewController {
    
    let searchController = SearchController()
    
    override func viewDidLoad() {
        super.viewDidLoad()
        searchController.delegate = self
    }
    
    func showSearch() {
        // Present as modal
        present(searchController, animated: true)
        
        // Or push to navigation stack
        // navigationController?.pushViewController(searchController, animated: true)
    }
}
```

### SearchController Configuration

```swift
// Create with custom configuration
let configuration = Configuration(
    allowsFeedbackUI: true,
    categoryDataProvider: DefaultCategoryDataProvider(),
    locationProvider: DefaultLocationProvider()
)

let searchController = SearchController(configuration: configuration)
```

---

## Forward Geocoding

Convert addresses/place names to geographic coordinates.

### Using SearchEngine

```swift
import MapboxSearch

class GeocodingService {
    
    private let searchEngine = SearchEngine()
    
    func searchAddress(_ query: String) async throws -> [SearchResult] {
        return try await withCheckedThrowingContinuation { continuation in
            searchEngine.search(query: query) { response in
                switch response {
                case .success(let results):
                    continuation.resume(returning: results)
                case .failure(let error):
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}

// Usage
let service = GeocodingService()

Task {
    do {
        let results = try await service.searchAddress("Lincoln Memorial, Washington DC")
        
        if let firstResult = results.first {
            print("Name: \(firstResult.name)")
            print("Coordinates: \(firstResult.coordinate)")
        }
    } catch {
        print("Search error: \(error)")
    }
}
```

### With Search Options

```swift
let options = SearchOptions(
    countries: ["US", "CA"],  // Limit to specific countries
    languages: ["en"],         // Result language
    limit: 10,                 // Max results
    proximity: userLocation    // Bias results to location
)

searchEngine.search(query: "coffee shop", options: options) { response in
    // Handle response
}
```

---

## Reverse Geocoding

Convert geographic coordinates to addresses.

```swift
import MapboxSearch
import CoreLocation

class ReverseGeocodingService {
    
    private let searchEngine = SearchEngine()
    
    func reverseGeocode(coordinate: CLLocationCoordinate2D) async throws -> [SearchResult] {
        return try await withCheckedThrowingContinuation { continuation in
            let options = ReverseGeocodingOptions(point: coordinate)
            
            searchEngine.reverseGeocoding(options: options) { response in
                switch response {
                case .success(let results):
                    continuation.resume(returning: results)
                case .failure(let error):
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}

// Usage
let service = ReverseGeocodingService()
let coordinate = CLLocationCoordinate2D(latitude: 38.8893, longitude: -77.0502)

Task {
    do {
        let results = try await service.reverseGeocode(coordinate: coordinate)
        
        if let firstResult = results.first {
            print("Address: \(firstResult.address?.formattedAddress(style: .full) ?? "Unknown")")
        }
    } catch {
        print("Reverse geocoding error: \(error)")
    }
}
```

---

## Place Autocomplete

Get real-time place suggestions as users type.

### Basic Implementation

```swift
import MapboxSearch

class AutocompleteService {
    
    private let placeAutocomplete = PlaceAutocomplete()
    
    func getSuggestions(for query: String) async throws -> [PlaceAutocomplete.Suggestion] {
        return try await withCheckedThrowingContinuation { continuation in
            placeAutocomplete.suggestions(for: query) { result in
                switch result {
                case .success(let suggestions):
                    continuation.resume(returning: suggestions)
                case .failure(let error):
                    continuation.resume(throwing: error)
                }
            }
        }
    }
    
    func selectSuggestion(_ suggestion: PlaceAutocomplete.Suggestion) async throws -> PlaceAutocomplete.Result {
        return try await withCheckedThrowingContinuation { continuation in
            placeAutocomplete.select(suggestion: suggestion) { result in
                switch result {
                case .success(let placeResult):
                    continuation.resume(returning: placeResult)
                case .failure(let error):
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}

// Usage with UITextField
class SearchFieldController: UIViewController, UITextFieldDelegate {
    
    @IBOutlet weak var searchField: UITextField!
    @IBOutlet weak var resultsTableView: UITableView!
    
    private let autocompleteService = AutocompleteService()
    private var suggestions: [PlaceAutocomplete.Suggestion] = []
    
    func textFieldDidChangeSelection(_ textField: UITextField) {
        guard let query = textField.text, !query.isEmpty else {
            suggestions = []
            resultsTableView.reloadData()
            return
        }
        
        Task {
            do {
                suggestions = try await autocompleteService.getSuggestions(for: query)
                await MainActor.run {
                    resultsTableView.reloadData()
                }
            } catch {
                print("Autocomplete error: \(error)")
            }
        }
    }
}
```

### Autocomplete Options

```swift
let options = PlaceAutocomplete.Options(
    countries: ["US"],              // Country filter
    language: "en",                  // Result language
    limit: 10,                       // Max suggestions
    types: [.POI, .address],        // Result types
    navigationProfile: .driving      // For route-based biasing
)

placeAutocomplete.suggestions(for: query, with: options) { result in
    // Handle result
}
```

---

## Category Search (Discover)

Find Points of Interest (POIs) by category.

### Using Discover Class

```swift
import MapboxSearch
import CoreLocation

class DiscoverService {
    
    private let discover = Discover()
    
    // Search nearby POIs by category
    func searchNearby(
        category: Discover.Query.Category,
        proximity: CLLocationCoordinate2D
    ) async throws -> [Discover.Result] {
        return try await withCheckedThrowingContinuation { continuation in
            let query = Discover.Query(category: category, proximity: proximity)
            
            discover.search(for: query) { result in
                switch result {
                case .success(let results):
                    continuation.resume(returning: results)
                case .failure(let error):
                    continuation.resume(throwing: error)
                }
            }
        }
    }
    
    // Search POIs in a specific area
    func searchInRegion(
        category: Discover.Query.Category,
        region: BoundingBox
    ) async throws -> [Discover.Result] {
        return try await withCheckedThrowingContinuation { continuation in
            let query = Discover.Query(category: category, boundingBox: region)
            
            discover.search(for: query) { result in
                switch result {
                case .success(let results):
                    continuation.resume(returning: results)
                case .failure(let error):
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}

// Usage
let service = DiscoverService()
let userLocation = CLLocationCoordinate2D(latitude: 37.7749, longitude: -122.4194)

Task {
    do {
        // Search for coffee shops nearby
        let coffeeShops = try await service.searchNearby(
            category: .coffeeShopCafe,
            proximity: userLocation
        )
        
        for shop in coffeeShops {
            print("Name: \(shop.name)")
            print("Distance: \(shop.distance ?? 0) meters")
            print("Address: \(shop.address?.formattedAddress(style: .short) ?? "N/A")")
        }
    } catch {
        print("Category search error: \(error)")
    }
}
```

### Available Categories

```swift
// Common POI categories
Discover.Query.Category.coffeeShopCafe
Discover.Query.Category.restaurant
Discover.Query.Category.hotel
Discover.Query.Category.gasStation
Discover.Query.Category.atm
Discover.Query.Category.hospital
Discover.Query.Category.pharmacy
Discover.Query.Category.parking
Discover.Query.Category.gym
Discover.Query.Category.bar
Discover.Query.Category.nightclub
Discover.Query.Category.museum
Discover.Query.Category.theater
Discover.Query.Category.shopping

// Or use custom category string
let customCategory = Discover.Query.Category(canonicalId: "your_category_id")
```

### Search Along Route

```swift
// For navigation apps: find POIs along a route
let routeCoordinates: [CLLocationCoordinate2D] = [
    // Your route coordinates
]

let query = Discover.Query(
    category: .gasStation,
    route: routeCoordinates
)

discover.search(for: query) { result in
    // Handle results along the route
}
```

---

## SearchController Customization

### Custom Appearance

```swift
// Customize colors and styling
let searchController = SearchController()

// Background color
searchController.view.backgroundColor = .systemBackground

// Search bar customization via configuration
let config = Configuration(
    style: .automatic,  // .light, .dark, or .automatic
    allowsFeedbackUI: true
)

let customController = SearchController(configuration: config)
```

### Custom Categories

```swift
// Provide custom category data
class CustomCategoryProvider: CategoryDataProvider {
    var categories: [SearchCategory] {
        return [
            SearchCategory(name: "Restaurants", id: "restaurant", icon: UIImage(systemName: "fork.knife")!),
            SearchCategory(name: "Hotels", id: "hotel", icon: UIImage(systemName: "bed.double")!),
            SearchCategory(name: "Gas Stations", id: "gas_station", icon: UIImage(systemName: "fuelpump")!)
        ]
    }
}

let config = Configuration(
    categoryDataProvider: CustomCategoryProvider()
)

let searchController = SearchController(configuration: config)
```

---

## Custom Search Bar

Build your own search interface using the core Search API.

### UIKit Implementation

```swift
import UIKit
import MapboxSearch

class CustomSearchViewController: UIViewController {
    
    // MARK: - UI Elements
    
    private let searchBar: UISearchBar = {
        let bar = UISearchBar()
        bar.placeholder = "Search for places..."
        bar.translatesAutoresizingMaskIntoConstraints = false
        return bar
    }()
    
    private let tableView: UITableView = {
        let table = UITableView()
        table.translatesAutoresizingMaskIntoConstraints = false
        return table
    }()
    
    // MARK: - Properties
    
    private let placeAutocomplete = PlaceAutocomplete()
    private var suggestions: [PlaceAutocomplete.Suggestion] = []
    private var searchWorkItem: DispatchWorkItem?
    
    // MARK: - Lifecycle
    
    override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
        setupDelegates()
    }
    
    // MARK: - Setup
    
    private func setupUI() {
        view.backgroundColor = .systemBackground
        view.addSubview(searchBar)
        view.addSubview(tableView)
        
        NSLayoutConstraint.activate([
            searchBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            searchBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            searchBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            
            tableView.topAnchor.constraint(equalTo: searchBar.bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }
    
    private func setupDelegates() {
        searchBar.delegate = self
        tableView.dataSource = self
        tableView.delegate = self
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "Cell")
    }
    
    // MARK: - Search
    
    private func performSearch(query: String) {
        // Cancel previous search
        searchWorkItem?.cancel()
        
        // Debounce search
        let workItem = DispatchWorkItem { [weak self] in
            self?.placeAutocomplete.suggestions(for: query) { [weak self] result in
                DispatchQueue.main.async {
                    switch result {
                    case .success(let suggestions):
                        self?.suggestions = suggestions
                        self?.tableView.reloadData()
                    case .failure(let error):
                        print("Search error: \(error)")
                    }
                }
            }
        }
        
        searchWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: workItem)
    }
}

// MARK: - UISearchBarDelegate

extension CustomSearchViewController: UISearchBarDelegate {
    
    func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) {
        guard !searchText.isEmpty else {
            suggestions = []
            tableView.reloadData()
            return
        }
        performSearch(query: searchText)
    }
}

// MARK: - UITableViewDataSource & Delegate

extension CustomSearchViewController: UITableViewDataSource, UITableViewDelegate {
    
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        return suggestions.count
    }
    
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "Cell", for: indexPath)
        let suggestion = suggestions[indexPath.row]
        
        var content = cell.defaultContentConfiguration()
        content.text = suggestion.name
        content.secondaryText = suggestion.formattedAddress
        cell.contentConfiguration = content
        
        return cell
    }
    
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        
        let suggestion = suggestions[indexPath.row]
        placeAutocomplete.select(suggestion: suggestion) { [weak self] result in
            switch result {
            case .success(let placeResult):
                print("Selected: \(placeResult.name)")
                print("Coordinates: \(placeResult.coordinate)")
                // Navigate to location or perform action
            case .failure(let error):
                print("Selection error: \(error)")
            }
        }
    }
}
```

---

## Result Filtering

Filter search results by type, country, or custom criteria.

### Filter by Result Type

```swift
let options = PlaceAutocomplete.Options(
    types: [.POI, .address]  // Only POIs and addresses
)

// Available types:
// .POI - Points of Interest
// .address - Specific addresses
// .place - Cities, neighborhoods
// .country - Countries
// .region - States, provinces
// .postcode - Postal codes
```

### Filter by Country

```swift
let options = PlaceAutocomplete.Options(
    countries: ["US", "CA", "MX"]  // ISO 3166-1 alpha-2 codes
)
```

### Custom Result Filtering

```swift
placeAutocomplete.suggestions(for: query) { result in
    switch result {
    case .success(let suggestions):
        // Filter results client-side
        let filteredSuggestions = suggestions.filter { suggestion in
            // Custom filter logic
            return suggestion.distance ?? 0 < 10000  // Within 10km
        }
        
        self.displayResults(filteredSuggestions)
        
    case .failure(let error):
        print("Error: \(error)")
    }
}
```

---

## Proximity Biasing

Bias search results toward a specific location.

```swift
import CoreLocation

// Get user's current location
let userLocation = CLLocationCoordinate2D(latitude: 37.7749, longitude: -122.4194)

// Configure proximity biasing
let options = PlaceAutocomplete.Options(
    proximity: userLocation
)

placeAutocomplete.suggestions(for: "coffee", with: options) { result in
    // Results biased toward userLocation
}
```

### With SearchEngine

```swift
let searchEngine = SearchEngine()

let options = SearchOptions(
    proximity: userLocation,
    boundingBox: BoundingBox(  // Optional: limit to area
        southwest: CLLocationCoordinate2D(latitude: 37.7, longitude: -122.5),
        northeast: CLLocationCoordinate2D(latitude: 37.9, longitude: -122.3)
    )
)

searchEngine.search(query: "restaurant", options: options) { response in
    // Handle response
}
```

---

## Language Configuration

Configure the language for search results.

```swift
// Single language
let options = PlaceAutocomplete.Options(
    language: "nl"  // Dutch
)

// Multiple languages (fallback order)
let options = SearchOptions(
    languages: ["nl", "en", "de"]  // Dutch, then English, then German
)
```

### Supported Languages

Common language codes:
- `en` - English
- `nl` - Dutch
- `de` - German
- `fr` - French
- `es` - Spanish
- `it` - Italian
- `pt` - Portuguese
- `zh` - Chinese
- `ja` - Japanese
- `ko` - Korean

---

## SwiftUI Integration

The MapboxSearchUI is built for UIKit, so you need to wrap it for SwiftUI.

### SearchController Wrapper

```swift
import SwiftUI
import MapboxSearchUI

struct SearchControllerView: UIViewControllerRepresentable {
    
    @Binding var selectedResult: SearchResult?
    var onDismiss: (() -> Void)?
    
    func makeUIViewController(context: Context) -> SearchController {
        let searchController = SearchController()
        searchController.delegate = context.coordinator
        return searchController
    }
    
    func updateUIViewController(_ uiViewController: SearchController, context: Context) {
        // Update if needed
    }
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    class Coordinator: NSObject, SearchControllerDelegate {
        var parent: SearchControllerView
        
        init(_ parent: SearchControllerView) {
            self.parent = parent
        }
        
        func searchResultSelected(_ searchResult: SearchResult) {
            parent.selectedResult = searchResult
            parent.onDismiss?()
        }
        
        func categorySearchResultsReceived(results: [SearchResult]) {
            // Handle category results
        }
        
        func userFavoriteSelected(_ favorite: FavoriteRecord) {
            // Handle favorite selection
        }
    }
}

// Usage in SwiftUI
struct ContentView: View {
    
    @State private var showSearch = false
    @State private var selectedResult: SearchResult?
    
    var body: some View {
        VStack {
            if let result = selectedResult {
                Text("Selected: \(result.name)")
                Text("Coordinates: \(result.coordinate.latitude), \(result.coordinate.longitude)")
            }
            
            Button("Search") {
                showSearch = true
            }
        }
        .sheet(isPresented: $showSearch) {
            SearchControllerView(
                selectedResult: $selectedResult,
                onDismiss: { showSearch = false }
            )
        }
    }
}
```

### Custom Search View in SwiftUI

```swift
import SwiftUI
import MapboxSearch

struct CustomSearchView: View {
    
    @State private var searchText = ""
    @State private var suggestions: [PlaceAutocomplete.Suggestion] = []
    @State private var isLoading = false
    
    private let placeAutocomplete = PlaceAutocomplete()
    
    var body: some View {
        VStack(spacing: 0) {
            // Search Bar
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.gray)
                
                TextField("Search places...", text: $searchText)
                    .textFieldStyle(.plain)
                    .onChange(of: searchText) { newValue in
                        search(query: newValue)
                    }
                
                if !searchText.isEmpty {
                    Button(action: { searchText = "" }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.gray)
                    }
                }
            }
            .padding()
            .background(Color(.systemGray6))
            .cornerRadius(10)
            .padding()
            
            // Results List
            if isLoading {
                ProgressView()
                    .padding()
            } else {
                List(suggestions, id: \.id) { suggestion in
                    VStack(alignment: .leading) {
                        Text(suggestion.name)
                            .font(.headline)
                        Text(suggestion.formattedAddress ?? "")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                    .onTapGesture {
                        selectSuggestion(suggestion)
                    }
                }
                .listStyle(.plain)
            }
            
            Spacer()
        }
    }
    
    private func search(query: String) {
        guard !query.isEmpty else {
            suggestions = []
            return
        }
        
        isLoading = true
        
        placeAutocomplete.suggestions(for: query) { result in
            DispatchQueue.main.async {
                isLoading = false
                switch result {
                case .success(let results):
                    suggestions = results
                case .failure(let error):
                    print("Search error: \(error)")
                }
            }
        }
    }
    
    private func selectSuggestion(_ suggestion: PlaceAutocomplete.Suggestion) {
        placeAutocomplete.select(suggestion: suggestion) { result in
            switch result {
            case .success(let placeResult):
                print("Selected: \(placeResult.name)")
                print("Coordinates: \(placeResult.coordinate)")
            case .failure(let error):
                print("Selection error: \(error)")
            }
        }
    }
}
```

---

## Maps SDK Integration

Integrate Search SDK with Mapbox Maps SDK for complete location experience.

### Show Search Results on Map

```swift
import UIKit
import MapboxMaps
import MapboxSearch
import MapboxSearchUI

class MapSearchViewController: UIViewController {
    
    // MARK: - Properties
    
    private var mapView: MapView!
    private var pointAnnotationManager: PointAnnotationManager!
    private let searchController = SearchController()
    
    // MARK: - Lifecycle
    
    override func viewDidLoad() {
        super.viewDidLoad()
        setupMapView()
        setupSearch()
    }
    
    // MARK: - Setup
    
    private func setupMapView() {
        let options = MapInitOptions(cameraOptions: CameraOptions(
            center: CLLocationCoordinate2D(latitude: 37.7749, longitude: -122.4194),
            zoom: 12
        ))
        
        mapView = MapView(frame: view.bounds, mapInitOptions: options)
        mapView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(mapView)
        
        // Create annotation manager
        pointAnnotationManager = mapView.annotations.makePointAnnotationManager()
    }
    
    private func setupSearch() {
        searchController.delegate = self
        
        // Add search button
        let searchButton = UIButton(type: .system)
        searchButton.setImage(UIImage(systemName: "magnifyingglass"), for: .normal)
        searchButton.backgroundColor = .systemBackground
        searchButton.layer.cornerRadius = 25
        searchButton.frame = CGRect(x: 20, y: 100, width: 50, height: 50)
        searchButton.addTarget(self, action: #selector(showSearch), for: .touchUpInside)
        view.addSubview(searchButton)
    }
    
    @objc private func showSearch() {
        present(searchController, animated: true)
    }
    
    // MARK: - Map Annotations
    
    private func showResultOnMap(_ result: SearchResult) {
        // Create annotation
        var annotation = PointAnnotation(coordinate: result.coordinate)
        annotation.image = .init(image: UIImage(systemName: "mappin.circle.fill")!, name: "pin")
        
        // Add to map
        pointAnnotationManager.annotations = [annotation]
        
        // Move camera to result
        let cameraOptions = CameraOptions(
            center: result.coordinate,
            zoom: 15
        )
        mapView.camera.ease(to: cameraOptions, duration: 0.5)
    }
}

// MARK: - SearchControllerDelegate

extension MapSearchViewController: SearchControllerDelegate {
    
    func searchResultSelected(_ searchResult: SearchResult) {
        dismiss(animated: true) {
            self.showResultOnMap(searchResult)
        }
    }
    
    func categorySearchResultsReceived(results: [SearchResult]) {
        dismiss(animated: true) {
            self.showMultipleResults(results)
        }
    }
    
    func userFavoriteSelected(_ favorite: FavoriteRecord) {
        dismiss(animated: true) {
            // Create SearchResult-like display
            let coordinate = favorite.coordinate
            var annotation = PointAnnotation(coordinate: coordinate)
            annotation.image = .init(image: UIImage(systemName: "star.fill")!, name: "favorite")
            self.pointAnnotationManager.annotations = [annotation]
            
            self.mapView.camera.ease(
                to: CameraOptions(center: coordinate, zoom: 15),
                duration: 0.5
            )
        }
    }
    
    private func showMultipleResults(_ results: [SearchResult]) {
        let annotations = results.map { result -> PointAnnotation in
            var annotation = PointAnnotation(coordinate: result.coordinate)
            annotation.image = .init(image: UIImage(systemName: "mappin.circle.fill")!, name: "pin")
            return annotation
        }
        
        pointAnnotationManager.annotations = annotations
        
        // Fit camera to show all results
        if let firstCoord = results.first?.coordinate,
           let lastCoord = results.last?.coordinate {
            let bounds = CoordinateBounds(
                southwest: firstCoord,
                northeast: lastCoord
            )
            
            let camera = mapView.mapboxMap.camera(
                for: bounds,
                padding: UIEdgeInsets(top: 50, left: 50, bottom: 50, right: 50),
                bearing: nil,
                pitch: nil
            )
            
            mapView.camera.ease(to: camera, duration: 0.5)
        }
    }
}
```

---

## Search History & Favorites

### Managing Search History

```swift
import MapboxSearch

class HistoryManager {
    
    private let historyProvider = HistoryProvider()
    
    // Get search history
    func getHistory() -> [HistoryRecord] {
        return historyProvider.records
    }
    
    // Add to history
    func addToHistory(_ record: HistoryRecord) {
        historyProvider.add(record: record)
    }
    
    // Clear history
    func clearHistory() {
        historyProvider.clear()
    }
    
    // Delete specific record
    func deleteRecord(_ record: HistoryRecord) {
        historyProvider.delete(record: record)
    }
}
```

### Managing Favorites

```swift
import MapboxSearch

class FavoritesManager {
    
    private let favoritesProvider = FavoritesProvider()
    
    // Get all favorites
    func getFavorites() -> [FavoriteRecord] {
        return favoritesProvider.records
    }
    
    // Add favorite
    func addFavorite(from searchResult: SearchResult, name: String? = nil) {
        let favorite = FavoriteRecord(
            name: name ?? searchResult.name,
            coordinate: searchResult.coordinate,
            address: searchResult.address
        )
        favoritesProvider.add(record: favorite)
    }
    
    // Remove favorite
    func removeFavorite(_ favorite: FavoriteRecord) {
        favoritesProvider.delete(record: favorite)
    }
    
    // Update favorite
    func updateFavorite(_ favorite: FavoriteRecord, newName: String) {
        var updated = favorite
        updated.name = newName
        favoritesProvider.update(record: updated)
    }
}
```

---

## Offline Search

Limited offline search capabilities using cached data.

```swift
import MapboxSearch

class OfflineSearchService {
    
    private let offlineManager = OfflineManager()
    
    // Check if offline data is available
    func isOfflineDataAvailable(for region: String) -> Bool {
        return offlineManager.hasDownloadedRegion(region)
    }
    
    // Download region for offline use
    func downloadRegion(_ region: TileRegion) async throws {
        try await offlineManager.downloadTileRegion(region)
    }
    
    // Search offline
    func searchOffline(query: String, in region: String) async throws -> [SearchResult] {
        // Offline search is limited to downloaded regions
        let options = SearchOptions(
            offlineMode: true
        )
        
        return try await withCheckedThrowingContinuation { continuation in
            // Use SearchEngine with offline mode
            // Note: Full implementation depends on SDK version
        }
    }
}
```

---

## API Reference

### Core Classes

| Class | Description |
|-------|-------------|
| `SearchEngine` | Main search engine for geocoding queries |
| `PlaceAutocomplete` | Real-time place suggestions |
| `Discover` | Category-based POI search |
| `SearchController` | Drop-in search UI component |

### Key Protocols

| Protocol | Description |
|----------|-------------|
| `SearchControllerDelegate` | Handle search result selection |
| `SearchEngineDelegate` | Handle search engine events |

### Data Classes

| Class | Description |
|-------|-------------|
| `SearchResult` | Single search result |
| `SearchSuggestion` | Autocomplete suggestion |
| `SearchAddress` | Address components |
| `FavoriteRecord` | Saved favorite location |
| `HistoryRecord` | Search history item |

### Options Classes

| Class | Description |
|-------|-------------|
| `SearchOptions` | Configure search behavior |
| `PlaceAutocomplete.Options` | Configure autocomplete |
| `ReverseGeocodingOptions` | Configure reverse geocoding |

---

## Troubleshooting

### Common Issues

#### 1. "Failed to download SDK" Error

**Problem:** Swift Package Manager fails to download

**Solution:**
```bash
# Verify .netrc file
cat ~/.netrc

# Should contain:
# machine api.mapbox.com
# login mapbox
# password YOUR_SECRET_TOKEN
```

#### 2. No Search Results

**Problem:** Searches return empty results

**Solution:**
- Verify access token is correct in Info.plist
- Check internet connectivity
- Verify search query is not empty
- Check country/region filters aren't too restrictive

#### 3. SearchController Not Showing

**Problem:** SearchController doesn't appear

**Solution:**
```swift
// Ensure proper presentation
let searchController = SearchController()

// Present modally
searchController.modalPresentationStyle = .fullScreen
present(searchController, animated: true)

// Or embed in navigation
navigationController?.pushViewController(searchController, animated: true)
```

#### 4. Location Bias Not Working

**Problem:** Results not biased to user location

**Solution:**
```swift
// Ensure location permissions are granted
// And provide valid coordinates

let options = PlaceAutocomplete.Options(
    proximity: CLLocationCoordinate2D(
        latitude: validLatitude,  // Must be -90 to 90
        longitude: validLongitude // Must be -180 to 180
    )
)
```

### Debug Logging

```swift
#if DEBUG
import MapboxSearch

// Enable verbose logging
SearchEngine.shared.setLogging(level: .debug)
#endif
```

---

## Resources

### Official Documentation

- [Mapbox Search SDK for iOS Documentation](https://docs.mapbox.com/ios/search/guides/)
- [Installation Guide](https://docs.mapbox.com/ios/search/guides/install/)
- [API Reference](https://docs.mapbox.com/ios/search/api-reference/)
- [Examples](https://docs.mapbox.com/ios/search/examples/)

### GitHub Resources

- [SDK Repository](https://github.com/mapbox/mapbox-search-ios)
- [Demo App Code](https://github.com/mapbox/mapbox-search-ios/tree/main/Demo)

### Related SDKs

- [Mapbox Maps SDK for iOS](https://docs.mapbox.com/ios/maps/)
- [Mapbox Navigation SDK for iOS](https://docs.mapbox.com/ios/navigation/guides/)

### Community & Support

- [Mapbox Discord Community](https://discord.gg/mapbox)
- [Stack Overflow (mapbox-search tag)](https://stackoverflow.com/questions/tagged/mapbox-search)
- [Mapbox Support](https://support.mapbox.com/)

---

## 🔗 Gerelateerde Documentatie

| Document | Beschrijving |
|----------|--------------|
| [📍 Mapbox iOS Navigation SDK Guide](Mapbox-iOS-Navigation-SDK-Guide.md) | Turn-by-turn navigatie, route berekening, CarPlay |

---

## License

The Mapbox Search SDK for iOS is available under the Mapbox Terms of Service. See [Mapbox Legal](https://www.mapbox.com/legal/) for details.

---

*This documentation was compiled from official Mapbox sources and is intended as a comprehensive reference guide. For the most up-to-date information, always refer to the [official Mapbox documentation](https://docs.mapbox.com/ios/search/guides/).*
