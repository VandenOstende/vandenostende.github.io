# Mapbox iOS Navigation SDK - Complete Documentation Guide

> **Version:** Navigation SDK v3  
> **Last Updated:** November 2025  
> **Platform:** iOS 14.0+  
> **Language:** Swift 5.9+

---

## Table of Contents

1. [Overview](#overview)
2. [Features](#features)
3. [Requirements](#requirements)
4. [Installation](#installation)
5. [Configuration](#configuration)
6. [Quick Start Guide](#quick-start-guide)
7. [Turn-by-Turn Navigation](#turn-by-turn-navigation)
8. [Free-Drive Mode (Passive Navigation)](#free-drive-mode-passive-navigation)
9. [Route Customization](#route-customization)
10. [Voice Instructions](#voice-instructions)
11. [Camera Controls](#camera-controls)
12. [CarPlay Integration](#carplay-integration)
13. [Offline Navigation](#offline-navigation)
14. [Rerouting](#rerouting)
15. [Migration Guide (v2 to v3)](#migration-guide-v2-to-v3)
16. [Pricing](#pricing)
17. [API Reference](#api-reference)
18. [Troubleshooting](#troubleshooting)
19. [Resources](#resources)

---

## Overview

The **Mapbox Navigation SDK for iOS** enables developers to add advanced turn-by-turn navigation capabilities to their iOS applications. Built on top of the Mapbox Directions API, Map Matching, and Maps SDK, it provides both a ready-to-use navigation UI and highly customizable components for building bespoke navigation experiences.

### Key Highlights

- 🚗 Complete turn-by-turn navigation for iPhone, iPad, and CarPlay
- 🗺️ Worldwide routing support for car, cycling, and walking profiles
- 🎨 Customizable map styles with day/night mode support
- 🔊 Multi-language voice instructions with SSML support
- 📡 Real-time traffic, incidents, and closures avoidance
- 🛣️ Alternative route generation with continuous updating
- 📴 Offline routing capabilities
- 🎥 Intelligent navigation camera controls

---

## Features

### Navigation Modes

| Mode | Description |
|------|-------------|
| **Active Navigation** | Turn-by-turn guidance with voice instructions |
| **Free-Drive (Passive)** | Location tracking without a set destination |

### Core Capabilities

- **Route Line Rendering** - Display and customize navigation routes on the map
- **Real-time Location Updates** - Accurate device location with map matching
- **Voice Instructions** - Spoken turn-by-turn directions in multiple languages
- **Visual Instructions** - Maneuver banners, lane guidance, and signboard display
- **Traffic Integration** - Live traffic data and alternative route suggestions
- **Speed Limits** - Display current road speed limits
- **Trip Progress** - Show remaining distance, time, and arrival estimates
- **Rerouting** - Automatic and manual rerouting capabilities
- **Alternative Routes** - Display and switch between route options

---

## Requirements

### SDK v3 Requirements

| Requirement | Minimum Version |
|-------------|-----------------|
| **Swift** | 5.9+ |
| **Xcode** | 15.0+ |
| **iOS** | 14.0+ |
| **Mapbox Maps SDK** | v11 |

### Future Versions

- Swift 6 support is planned for future releases
- Xcode 16.0+ will be required for upcoming updates

---

## Installation

### Step 1: Create a Mapbox Account

1. Sign up at [mapbox.com](https://www.mapbox.com/)
2. Navigate to your Account dashboard
3. Access the Tokens section

### Step 2: Generate Access Tokens

You need **two types of tokens**:

#### Private Token (for SDK Download)
- Create a token with `DOWNLOADS:READ` scope
- Used only during installation
- Store securely (never in source code)

#### Public Token (for Runtime API Access)
- Default token from your dashboard
- Used for API calls at runtime
- Will be added to your app's Info.plist

### Step 3: Configure .netrc File

Create or edit `~/.netrc` in your home directory:

```bash
machine api.mapbox.com
login mapbox
password YOUR_PRIVATE_MAPBOX_API_TOKEN
```

> ⚠️ **Important:** Never commit your private token to source control!

### Step 4: Install via Swift Package Manager

#### Using Xcode UI:

1. Open your project in Xcode
2. Go to **File → Swift Packages → Add Package Dependency**
3. Enter the repository URL:
   ```
   https://github.com/mapbox/mapbox-navigation-ios.git
   ```
4. Set version to `3.1.0` or later as minimum requirement
5. Click **Add Package**

#### Using Package.swift:

```swift
dependencies: [
    .package(
        url: "https://github.com/mapbox/mapbox-navigation-ios.git",
        from: "3.1.0"
    )
]
```

### Step 5: Install via CocoaPods (Alternative)

Add to your `Podfile`:

```ruby
pod 'MapboxNavigation', '~> 3.1.0'
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

### Configure Location Permissions

Add the following keys to `Info.plist`:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>Your app needs location access to provide navigation.</string>

<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>Your app needs background location access for turn-by-turn navigation.</string>
```

### Enable Background Modes

For continuous navigation, enable background modes in your target's Capabilities:

- ✅ **Audio, AirPlay, and Picture in Picture** (for voice instructions)
- ✅ **Location updates** (for background tracking)

Configure in `Info.plist`:

```xml
<key>UIBackgroundModes</key>
<array>
    <string>audio</string>
    <string>location</string>
</array>
```

---

## Quick Start Guide

### Basic Navigation Implementation

Here's a minimal example to get turn-by-turn navigation running:

```swift
import UIKit
import MapboxNavigationCore
import MapboxNavigationUIKit

class NavigationViewController: UIViewController {
    
    // MARK: - Properties
    
    private var navigationProvider: MapboxNavigationProvider!
    private var navigationController: NavigationViewController?
    
    // Define origin and destination coordinates
    let origin = CLLocationCoordinate2D(latitude: 37.7749, longitude: -122.4194) // San Francisco
    let destination = CLLocationCoordinate2D(latitude: 37.3382, longitude: -121.8863) // San Jose
    
    // MARK: - Lifecycle
    
    override func viewDidLoad() {
        super.viewDidLoad()
        setupNavigation()
    }
    
    // MARK: - Setup
    
    private func setupNavigation() {
        // Initialize the navigation provider with core configuration
        let coreConfig = CoreConfig()
        navigationProvider = MapboxNavigationProvider(coreConfig: coreConfig)
    }
    
    // MARK: - Navigation
    
    func startNavigation() async {
        do {
            // Get routing provider
            let routingProvider = navigationProvider.mapboxNavigation.routingProvider()
            
            // Create route options
            let routeOptions = RouteOptions(
                coordinates: [origin, destination],
                profileIdentifier: .automobile
            )
            
            // Calculate routes
            let navigationRoutes = try await routingProvider.calculateRoutes(
                options: routeOptions
            ).value
            
            // Create navigation options
            let navigationOptions = NavigationOptions(
                mapboxNavigation: navigationProvider.mapboxNavigation,
                voiceController: navigationProvider.routeVoiceController,
                eventsManager: navigationProvider.eventsManager()
            )
            
            // Create and present navigation view controller
            let navVC = NavigationViewController(
                navigationRoutes: navigationRoutes,
                navigationOptions: navigationOptions
            )
            navVC.modalPresentationStyle = .fullScreen
            
            // Present the navigation
            await MainActor.run {
                present(navVC, animated: true)
            }
            
        } catch {
            print("Failed to calculate route: \(error)")
        }
    }
}
```

### Using NavigationViewController (Drop-in UI)

The `NavigationViewController` provides a complete, ready-to-use navigation experience:

```swift
import MapboxNavigationUIKit

// After calculating routes...
let navigationViewController = NavigationViewController(
    navigationRoutes: routes,
    navigationOptions: navigationOptions
)

// Configure delegate for callbacks
navigationViewController.delegate = self

// Present full screen
navigationViewController.modalPresentationStyle = .fullScreen
present(navigationViewController, animated: true)
```

---

## Turn-by-Turn Navigation

### Route Request and Generation

```swift
import MapboxNavigationCore

// Create route options with multiple waypoints
let waypoints = [
    Waypoint(coordinate: startCoordinate, name: "Start"),
    Waypoint(coordinate: stopoverCoordinate, name: "Coffee Shop"),
    Waypoint(coordinate: destinationCoordinate, name: "Destination")
]

let routeOptions = RouteOptions(
    waypoints: waypoints,
    profileIdentifier: .automobile
)

// Configure additional options
routeOptions.includesAlternativeRoutes = true
routeOptions.allowsUTurnAtWaypoint = false

// Request routes
let routes = try await routingProvider.calculateRoutes(options: routeOptions).value
```

### Profile Types

| Profile | Description |
|---------|-------------|
| `.automobile` | Car navigation with traffic |
| `.automobileAvoidingTraffic` | Car routing avoiding traffic |
| `.cycling` | Bicycle-friendly routes |
| `.walking` | Pedestrian navigation |

### Handling Navigation Events

```swift
extension YourViewController: NavigationViewControllerDelegate {
    
    func navigationViewControllerDidDismiss(
        _ navigationViewController: NavigationViewController,
        byCanceling canceled: Bool
    ) {
        // Handle navigation dismissal
        if canceled {
            print("User canceled navigation")
        } else {
            print("Navigation completed")
        }
    }
    
    func navigationViewController(
        _ navigationViewController: NavigationViewController,
        didArriveAt waypoint: Waypoint
    ) -> Bool {
        // Handle arrival at waypoint
        print("Arrived at: \(waypoint.name ?? "Unknown")")
        
        // Return true to advance to next leg, false to stop
        return true
    }
}
```

---

## Free-Drive Mode (Passive Navigation)

Free-drive mode allows tracking the user's location without a set destination. Perfect for:
- Speed limit display while driving
- Traffic condition awareness
- POI discovery along the route

### Starting Free-Drive

```swift
import MapboxNavigationCore
import MapboxNavigationUIKit

class FreeDriveViewController: UIViewController {
    
    private var navigationProvider: MapboxNavigationProvider!
    private var mapView: NavigationMapView!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        setupFreeDrive()
    }
    
    private func setupFreeDrive() {
        // Initialize provider
        let coreConfig = CoreConfig()
        navigationProvider = MapboxNavigationProvider(coreConfig: coreConfig)
        
        // Setup map view
        mapView = NavigationMapView(frame: view.bounds)
        view.addSubview(mapView)
        
        // Start free-drive session
        startFreeDriveSession()
    }
    
    private func startFreeDriveSession() {
        let sessionController = navigationProvider.mapboxNavigation.sessionController()
        sessionController.startFreeDrive()
        
        // Subscribe to location updates
        subscribeToLocationUpdates()
    }
    
    private func subscribeToLocationUpdates() {
        let navigation = navigationProvider.mapboxNavigation
        
        // Observe location changes
        navigation.locationPublisher
            .sink { [weak self] location in
                self?.handleLocationUpdate(location)
            }
            .store(in: &cancellables)
    }
    
    private func handleLocationUpdate(_ location: CLLocation) {
        // Update UI with current speed, heading, etc.
        print("Current speed: \(location.speed) m/s")
    }
    
    private var cancellables = Set<AnyCancellable>()
}
```

### Transitioning from Free-Drive to Active Navigation

```swift
func transitionToActiveNavigation(to destination: CLLocationCoordinate2D) async {
    // Stop free-drive
    let sessionController = navigationProvider.mapboxNavigation.sessionController()
    sessionController.stopFreeDrive()
    
    // Calculate route from current location to destination
    let currentLocation = navigationProvider.mapboxNavigation.currentLocation
    let routeOptions = RouteOptions(
        coordinates: [currentLocation.coordinate, destination],
        profileIdentifier: .automobile
    )
    
    // Continue with turn-by-turn navigation...
}
```

---

## Route Customization

### Route Line Appearance

```swift
// Customize route line colors
let routeLineConfig = RouteLineConfiguration(
    mainRouteColor: .systemBlue,
    alternativeRouteColor: .systemGray,
    traversedRouteColor: .systemGray.withAlphaComponent(0.5)
)

// Traffic congestion colors
let congestionColors = CongestionColorsConfiguration(
    lowCongestionColor: .systemGreen,
    moderateCongestionColor: .systemYellow,
    heavyCongestionColor: .systemOrange,
    severeCongestionColor: .systemRed,
    unknownCongestionColor: .systemGray,
    displaySoftGradientForTraffic: true // Smooth gradient transitions
)
```

### Custom Map Styles

```swift
// Set day and night map styles
let dayStyle = StandardDayStyle()
let nightStyle = StandardNightStyle()

// Or use custom Mapbox styles
let customDayStyleURL = URL(string: "mapbox://styles/your-username/your-day-style")!
let customNightStyleURL = URL(string: "mapbox://styles/your-username/your-night-style")!

// Configure in NavigationOptions
let navigationOptions = NavigationOptions(
    styles: [customDayStyleURL, customNightStyleURL],
    mapboxNavigation: navigationProvider.mapboxNavigation,
    voiceController: navigationProvider.routeVoiceController,
    eventsManager: navigationProvider.eventsManager()
)
```

---

## Voice Instructions

### Default Voice Guidance

Voice instructions are enabled by default and support multiple languages.

```swift
// Voice controller is included in NavigationOptions
let voiceController = navigationProvider.routeVoiceController

// The system will automatically announce:
// - Upcoming maneuvers
// - Lane guidance
// - Speed limit warnings
// - Arrival notifications
```

### Customizing Voice Instructions

```swift
// Adjust voice instruction volume
voiceController.volume = 0.8 // 0.0 to 1.0

// Mute/unmute voice instructions
voiceController.isMuted = false
```

### SSML Support

The SDK supports Speech Synthesis Markup Language (SSML) for advanced voice control:

```swift
// Custom pronunciation and emphasis
let customInstruction = """
<speak>
    <say-as interpret-as="address">123 Main Street</say-as>
    Turn <emphasis level="strong">right</emphasis> in 
    <say-as interpret-as="unit">500 meters</say-as>
</speak>
"""
```

### Supported Languages

Voice instructions support numerous languages including:
- English (US, UK, AU)
- Spanish
- French
- German
- Italian
- Portuguese
- Dutch
- Japanese
- Korean
- Chinese (Simplified, Traditional)
- And many more...

---

## Camera Controls

### Default Camera Behavior

The navigation camera automatically:
- Follows the user's location
- Adjusts zoom based on speed and upcoming maneuvers
- Tilts for better road visibility
- Rotates to match the heading

### Camera States

```swift
// Available camera states
enum NavigationCameraState {
    case following    // Camera follows user location
    case overview     // Shows entire route
    case idle         // Manual control
}

// Change camera state
navigationMapView.navigationCamera.update(cameraState: .overview)
```

### Custom Camera Configuration

```swift
// Configure camera behavior
let cameraConfig = NavigationCameraConfiguration(
    followingZoomLevel: 16.0,
    overviewZoomLevel: 12.0,
    followingPitch: 45.0,
    overviewPitch: 0.0
)

// Apply custom configuration
navigationMapView.navigationCamera.update(configuration: cameraConfig)
```

### Manual Camera Control

```swift
// Temporarily disable automatic camera updates
navigationMapView.navigationCamera.stop()

// Manually set camera position
let cameraOptions = CameraOptions(
    center: customCoordinate,
    zoom: 14.0,
    bearing: 0.0,
    pitch: 45.0
)

navigationMapView.mapView.camera.ease(to: cameraOptions, duration: 0.5)

// Resume automatic updates
navigationMapView.navigationCamera.update(cameraState: .following)
```

---

## CarPlay Integration

### Setup CarPlay Support

1. **Add CarPlay Entitlement**
   - Request CarPlay Navigation entitlement from Apple
   - Add the entitlement to your app's provisioning profile

2. **Configure Info.plist**

```xml
<key>UIApplicationSceneManifest</key>
<dict>
    <key>UIApplicationSupportsMultipleScenes</key>
    <true/>
    <key>UISceneConfigurations</key>
    <dict>
        <key>CPTemplateApplicationSceneSessionRoleApplication</key>
        <array>
            <dict>
                <key>UISceneClassName</key>
                <string>CPTemplateApplicationScene</string>
                <key>UISceneConfigurationName</key>
                <string>CarPlay Configuration</string>
                <key>UISceneDelegateClassName</key>
                <string>$(PRODUCT_MODULE_NAME).CarPlaySceneDelegate</string>
            </dict>
        </array>
    </dict>
</dict>
```

### CarPlay Implementation

```swift
import CarPlay
import MapboxNavigationCore
import MapboxNavigationUIKit

class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    
    var carPlayManager: CarPlayManager?
    var navigationProvider: MapboxNavigationProvider?
    
    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        // Initialize navigation provider
        let coreConfig = CoreConfig()
        navigationProvider = MapboxNavigationProvider(coreConfig: coreConfig)
        
        // Create CarPlay manager
        carPlayManager = CarPlayManager(
            navigationProvider: navigationProvider!
        )
        carPlayManager?.delegate = self
        
        // Connect interface controller
        carPlayManager?.connect(interfaceController)
    }
    
    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnect interfaceController: CPInterfaceController
    ) {
        carPlayManager?.disconnect()
    }
}

// MARK: - CarPlayManagerDelegate

extension CarPlaySceneDelegate: CarPlayManagerDelegate {
    
    func carPlayManager(
        _ carPlayManager: CarPlayManager,
        didBeginNavigationWith service: NavigationService
    ) {
        print("CarPlay navigation started")
    }
    
    func carPlayManagerDidEndNavigation(_ carPlayManager: CarPlayManager) {
        print("CarPlay navigation ended")
    }
}
```

### CarPlay UI Customization

```swift
extension CarPlaySceneDelegate: CarPlayManagerDelegate {
    
    func carPlayManager(
        _ carPlayManager: CarPlayManager,
        trailingNavigationBarButtonsCompatibleWith traitCollection: UITraitCollection,
        in template: CPTemplate,
        for activity: CarPlayActivity
    ) -> [CPBarButton]? {
        
        // Add custom buttons to CarPlay navigation bar
        let muteButton = CPBarButton(type: .text) { [weak self] _ in
            self?.toggleVoiceInstructions()
        }
        muteButton.title = "Mute"
        
        return [muteButton]
    }
}
```

---

## Offline Navigation

### Predictive Caching

The SDK automatically caches map tiles and routing data along predicted routes:

```swift
// Configure predictive caching
let predictiveCacheConfig = PredictiveCacheConfig(
    predictiveCacheMapsConfig: PredictiveCacheMapsConfig(
        cacheRadius: 5000, // meters
        cacheSearchRadius: 3000
    ),
    predictiveCacheNavigationConfig: PredictiveCacheNavigationConfig(
        cacheRadius: 5000
    )
)

// Apply to core config
let coreConfig = CoreConfig(
    predictiveCacheConfig: predictiveCacheConfig
)

let navigationProvider = MapboxNavigationProvider(coreConfig: coreConfig)
```

### Manual Offline Regions

For guaranteed offline support, pre-download regions:

```swift
import MapboxMaps

class OfflineManager {
    
    private var offlineManager: OfflineManager!
    
    func downloadRegion(
        boundingBox: CoordinateBounds,
        styleURL: URL
    ) async throws {
        // Define the region to download
        let tileRegionLoadOptions = TileRegionLoadOptions(
            geometry: .polygon(Polygon(boundingBox)),
            descriptors: [
                TilesetDescriptor(
                    styleURI: .init(url: styleURL)
                )
            ],
            metadata: ["name": "offline_region"],
            acceptExpired: true
        )
        
        // Start download
        let tileRegion = try await offlineManager.loadTileRegion(
            forId: "my_offline_region",
            loadOptions: tileRegionLoadOptions
        )
        
        print("Downloaded region: \(tileRegion.id)")
    }
    
    func deleteRegion(id: String) async throws {
        try await offlineManager.removeTileRegion(forId: id)
    }
}
```

### Offline Routing

```swift
// Check if route can be calculated offline
let routingProvider = navigationProvider.mapboxNavigation.routingProvider()

// Calculate routes - SDK will use cached data when available
let routes = try await routingProvider.calculateRoutes(
    options: routeOptions
).value

// The SDK automatically falls back to cached routes when offline
```

---

## Rerouting

### Automatic Rerouting

The SDK automatically reroutes when:
- User goes off the planned route
- A faster route becomes available

```swift
// Subscribe to rerouting events
let navigation = navigationProvider.mapboxNavigation

navigation.reroutingPublisher
    .sink { reroutingStatus in
        switch reroutingStatus.event {
        case .fetching:
            print("Calculating new route...")
        case .fetched(let routes):
            print("New routes available")
        case .applied:
            print("Reroute applied")
        case .failed(let error):
            print("Reroute failed: \(error)")
        default:
            break
        }
    }
    .store(in: &cancellables)
```

### Faster Route Notifications

```swift
navigation.fasterRoutesPublisher
    .sink { fasterRouteEvent in
        // Notify user of faster route availability
        self.showFasterRouteAlert(newRoute: fasterRouteEvent.route)
    }
    .store(in: &cancellables)

func showFasterRouteAlert(newRoute: Route) {
    let alert = UIAlertController(
        title: "Faster Route Available",
        message: "A faster route has been found. Switch to new route?",
        preferredStyle: .alert
    )
    
    alert.addAction(UIAlertAction(title: "Yes", style: .default) { _ in
        self.switchToRoute(newRoute)
    })
    
    alert.addAction(UIAlertAction(title: "No", style: .cancel))
    
    present(alert, animated: true)
}
```

### Manual Rerouting

```swift
// Disable automatic rerouting
let coreConfig = CoreConfig(
    rerouteConfig: RerouteConfig(
        detectsReroute: false // Disable automatic reroute detection
    )
)

// Manually trigger reroute
func requestManualReroute() async {
    let routingProvider = navigationProvider.mapboxNavigation.routingProvider()
    
    let currentLocation = navigationProvider.mapboxNavigation.currentLocation
    let destination = currentRouteProgress.route.legs.last?.destination
    
    guard let destination = destination else { return }
    
    let routeOptions = RouteOptions(
        coordinates: [currentLocation.coordinate, destination.coordinate],
        profileIdentifier: .automobile
    )
    
    let newRoutes = try? await routingProvider.calculateRoutes(
        options: routeOptions
    ).value
    
    if let routes = newRoutes {
        // Apply new route
        navigationProvider.mapboxNavigation.tripSession.setRoutes(routes)
    }
}
```

---

## Migration Guide (v2 to v3)

### Major Breaking Changes

#### 1. SDK Configuration

**v2 (Old):**
```swift
let navigationService = NavigationService(
    routeResponse: routeResponse,
    routeIndex: 0,
    routeOptions: routeOptions
)
```

**v3 (New):**
```swift
let coreConfig = CoreConfig()
let navigationProvider = MapboxNavigationProvider(coreConfig: coreConfig)
let mapboxNavigation = navigationProvider.mapboxNavigation
```

#### 2. Entry Point Changes

| v2 | v3 |
|----|-----|
| `NavigationService` | `MapboxNavigation` via `MapboxNavigationProvider` |
| `Router` | Consolidated into `MapboxNavigation` |
| `PassiveLocationManager` | Consolidated into `MapboxNavigation` |
| `NavigationSettings` | `CoreConfig` |

#### 3. Single Instance Requirement

```swift
// v3 requires single MapboxNavigation instance
// ❌ Multiple instances will throw errors
let provider1 = MapboxNavigationProvider(coreConfig: config)
let provider2 = MapboxNavigationProvider(coreConfig: config) // Error!

// ✅ Correct: Use single instance throughout app
class NavigationManager {
    static let shared = NavigationManager()
    let navigationProvider: MapboxNavigationProvider
    
    private init() {
        let coreConfig = CoreConfig()
        navigationProvider = MapboxNavigationProvider(coreConfig: coreConfig)
    }
}
```

#### 4. Maps SDK Upgrade

- v3 uses **Mapbox Maps SDK v11** (v2 used v10)
- Review Maps SDK v11 migration guide for map-related changes
- New "Mapbox Standard" style support

### Deprecated Features

| Deprecated | Replacement |
|------------|-------------|
| `NavigationSettings` | `CoreConfig` |
| `ViewportState` properties | New equivalents in v3 |
| Telemetry userId/sessionId | Removed |
| Some CarPlay APIs | Updated CarPlay integration |

### Migration Steps

1. **Update Dependencies**
   - Ensure Xcode 15.0+ and Swift 5.9+
   - Update to iOS 14.0+ minimum deployment target

2. **Update SDK Initialization**
   ```swift
   // Replace NavigationSettings with CoreConfig
   let coreConfig = CoreConfig()
   let provider = MapboxNavigationProvider(coreConfig: coreConfig)
   ```

3. **Update Route Requests**
   ```swift
   // Use new routing provider
   let routingProvider = provider.mapboxNavigation.routingProvider()
   let routes = try await routingProvider.calculateRoutes(options: options).value
   ```

4. **Update UI Components**
   ```swift
   // Use new NavigationViewController initialization
   let navVC = NavigationViewController(
       navigationRoutes: routes,
       navigationOptions: navOptions
   )
   ```

5. **Test Thoroughly**
   - Test all navigation flows
   - Verify CarPlay integration
   - Check voice instructions
   - Validate offline functionality

---

## Pricing

### Pricing Models

| Model | Best For | Description |
|-------|----------|-------------|
| **Metered Trips** | Apps with <50 trips/user/month | Pay per trip + small MAU fee |
| **Unlimited Trips** | Apps with >200 trips/user/month | Fixed monthly fee per MAU |

> **MAU** = Monthly Active User

### Free Tier

Mapbox provides a free tier to help you validate technical feasibility:
- Limited free trips per month
- Full feature access
- Perfect for development and testing

### Cost Management

- Monitor usage in Mapbox Dashboard
- Set usage alerts and limits
- Track MAU and trip counts
- Use pricing calculator for estimates

### Contact Sales

For high-volume or enterprise needs:
- Custom pricing available
- Contact [Mapbox Sales](https://www.mapbox.com/contact/sales)
- Switch between pricing models as needed

---

## API Reference

### Core Classes

| Class | Description |
|-------|-------------|
| `MapboxNavigationProvider` | Main entry point for SDK initialization |
| `MapboxNavigation` | Core navigation instance |
| `NavigationViewController` | Drop-in navigation UI |
| `NavigationMapView` | Map view with navigation features |
| `RouteOptions` | Route request configuration |
| `NavigationRoutes` | Calculated route results |
| `CoreConfig` | SDK configuration |

### Key Publishers (Combine)

| Publisher | Events |
|-----------|--------|
| `locationPublisher` | Location updates |
| `routeProgressPublisher` | Route progress updates |
| `reroutingPublisher` | Rerouting status |
| `fasterRoutesPublisher` | Faster route notifications |
| `voiceInstructionPublisher` | Voice instruction events |

### Full API Documentation

For complete API reference, visit:
- [Navigation SDK v3 API Reference](https://docs.mapbox.com/ios/navigation/api-reference/)
- [GitHub Repository](https://github.com/mapbox/mapbox-navigation-ios/)

---

## Troubleshooting

### Common Issues

#### 1. Authentication Errors

**Problem:** "Failed to download SDK" or "401 Unauthorized"

**Solution:**
```bash
# Verify .netrc file exists and has correct format
cat ~/.netrc

# Should contain:
# machine api.mapbox.com
# login mapbox
# password YOUR_PRIVATE_TOKEN
```

#### 2. Location Not Updating

**Problem:** Map shows static location

**Solution:**
- Verify location permissions in Info.plist
- Check device location services are enabled
- Ensure background modes are configured
- Test on physical device (simulator has limitations)

#### 3. Voice Instructions Not Playing

**Problem:** Silent navigation

**Solution:**
```swift
// Check mute status
if voiceController.isMuted {
    voiceController.isMuted = false
}

// Check volume
voiceController.volume = 1.0

// Verify audio session category
try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
```

#### 4. Routes Not Calculating

**Problem:** Route request returns error

**Solution:**
- Verify public token in Info.plist
- Check internet connectivity
- Validate coordinates are within supported regions
- Ensure coordinates are in correct order (longitude, latitude)

#### 5. CarPlay Not Working

**Problem:** CarPlay connection fails

**Solution:**
- Verify CarPlay entitlement from Apple
- Check provisioning profile includes CarPlay
- Ensure CPTemplateApplicationSceneDelegate is properly configured
- Test with CarPlay simulator in Xcode

### Debug Logging

```swift
// Enable detailed logging
#if DEBUG
import MapboxNavigationCore

// Set log level
Log.level = .debug
#endif
```

---

## Resources

### Official Documentation

- [Mapbox Navigation SDK for iOS Documentation](https://docs.mapbox.com/ios/navigation/guides/)
- [Get Started Guide](https://docs.mapbox.com/ios/navigation/guides/get-started/)
- [Turn-by-Turn Navigation Guide](https://docs.mapbox.com/ios/navigation/guides/turn-by-turn-navigation/)
- [Free-Drive Navigation Guide](https://docs.mapbox.com/ios/navigation/guides/free-drive/)
- [CarPlay Integration Guide](https://docs.mapbox.com/ios/navigation/guides/system-integration/carplay/)
- [Offline Navigation Guide](https://docs.mapbox.com/ios/navigation/guides/advanced/offline/)
- [Migration Guide (v2 to v3)](https://docs.mapbox.com/ios/navigation/v3/guides/migrate-to-v3/)

### GitHub Resources

- [SDK Repository](https://github.com/mapbox/mapbox-navigation-ios/)
- [Example Projects](https://github.com/mapbox/mapbox-navigation-ios-examples)
- [Changelog](https://github.com/mapbox/mapbox-navigation-ios/blob/main/CHANGELOG.md)
- [Issue Tracker](https://github.com/mapbox/mapbox-navigation-ios/issues)

### Related SDKs

- [Mapbox Maps SDK for iOS](https://docs.mapbox.com/ios/maps/)
- [Mapbox Directions API](https://docs.mapbox.com/api/navigation/directions/)
- [Mapbox Search SDK](https://docs.mapbox.com/ios/search/)

### Community & Support

- [Mapbox Discord Community](https://discord.gg/mapbox)
- [Stack Overflow (mapbox tag)](https://stackoverflow.com/questions/tagged/mapbox)
- [Mapbox Support](https://support.mapbox.com/)

### Video Tutorials

- [Getting Started with Mapbox Maps SDK for iOS](https://www.youtube.com/watch?v=qQZshkW9_dQ)
- [Build a Navigation App for iOS](https://www.youtube.com/watch?v=0YQXAZhruog)

---

## License

The Mapbox Navigation SDK for iOS is available under the Mapbox Terms of Service. See [Mapbox Legal](https://www.mapbox.com/legal/) for details.

---

*This documentation was compiled from official Mapbox sources and is intended as a comprehensive reference guide. For the most up-to-date information, always refer to the [official Mapbox documentation](https://docs.mapbox.com/ios/navigation/guides/).*
