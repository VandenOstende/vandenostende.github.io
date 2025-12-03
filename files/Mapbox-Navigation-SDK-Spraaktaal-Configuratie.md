# Mapbox Navigation SDK v3 voor iOS - Spraaktaal Configuratie

Een uitgebreide handleiding voor het configureren van spraaktaal in turn-by-turn navigatie-instructies.

---

## Inhoudsopgave

1. [Inleiding](#inleiding)
2. [Spraaktaal Wijzigen via Locale](#spraaktaal-wijzigen-via-locale)
3. [Text-to-Speech Configuratie](#text-to-speech-configuratie)
4. [User Interface Lokalisatie](#user-interface-lokalisatie)
5. [AVSpeechSynthesizer en Siri-Stem](#avspeechsynthesizer-en-siri-stem)
6. [Ondersteunde Talen](#ondersteunde-talen)
7. [Samenvatting](#samenvatting)
8. [Bronverwijzingen](#bronverwijzingen)

---

## Inleiding

De Mapbox Navigation SDK v3 voor iOS biedt uitgebreide mogelijkheden voor het lokaliseren van navigatie-instructies. Standaard worden turn-by-turn instructies uitgesproken in de taal van de gebruikersinterface van de applicatie, maar ontwikkelaars hebben de flexibiliteit om deze taal aan te passen aan specifieke behoeften.

De SDK ondersteunt meer dan een dozijn belangrijke talen en diverse locale-instellingen. Om een naadloze gebruikerservaring te bieden, komt het standaardgedrag van de SDK zoveel mogelijk overeen met het standaard iOS-gedrag, maar er zijn ook verschillende aanpassingsopties beschikbaar voor gespecialiseerde toepassingen.

---

## Spraaktaal Wijzigen via Locale

### Basisprincipe

De eenvoudigste manier om de spraaktaal van navigatie-instructies te wijzigen is door de `locale` property in te stellen bij het berekenen van de route. Dit doe je via de `NavigationRouteOptions.locale` property.

### Code Voorbeeld

```swift
// Navigatie-instructies in het Nederlands
let routeOptions = NavigationRouteOptions(
    waypoints: waypoints, 
    locale: Locale(identifier: "nl_NL")
)
```

### Hoe werkt het?

1. **Bij het berekenen van de route**: Geef de gewenste `locale` mee aan `NavigationRouteOptions`
2. **Tijdens de navigatie**: De SDK gebruikt deze locale voor alle gesproken instructies
3. **Automatische fallback**: Als de gekozen taal niet wordt ondersteund door de Mapbox Voice API, valt de SDK automatisch terug op `AVSpeechSynthesizer`

### Belangrijke Locale Identifiers

| Taal | Locale Identifier |
|------|-------------------|
| Nederlands | `nl_NL` |
| Duits | `de_DE` |
| Frans | `fr_FR` |
| Spaans | `es_ES` |
| Italiaans | `it_IT` |
| Portugees | `pt_PT` |
| Engels (VS) | `en_US` |
| Engels (UK) | `en_GB` |

---

## Text-to-Speech Configuratie

De Mapbox Navigation SDK biedt drie verschillende configuraties voor de Text-to-Speech (TTS) engine, die je kunt instellen via de `CoreConfig.ttsConfig` property tijdens de SDK-initialisatie.

### 1. TTSConfig.default (Standaard)

De standaardconfiguratie die de meeste flexibiliteit biedt:

```swift
// Dit is de standaard configuratie
// Gebruikt MultiplexedSpeechSynthesizer
```

**Kenmerken:**
- Gebruikt `MultiplexedSpeechSynthesizer` om instructies uit te spreken
- Maakt primair gebruik van de **Mapbox Voice API** voor hoogwaardige spraak
- **Automatische fallback** naar `AVSpeechSynthesizer` wanneer:
  - De Voice API de taal niet ondersteunt
  - Er geen internetverbinding beschikbaar is

**Voordelen:**
- Hoogwaardige stemmen via Mapbox Voice API
- Offline ondersteuning via fallback
- Breed scala aan ondersteunde talen

**Nadelen:**
- Vereist internetverbinding voor optimale kwaliteit
- Verbruikt data tijdens navigatie

### 2. TTSConfig.localOnly

Voor volledige offline spraaksynthese:

```swift
// Altijd lokale spraaksynthese gebruiken
let config = CoreConfig(ttsConfig: .localOnly)
```

**Kenmerken:**
- Gebruikt **altijd** `AVSpeechSynthesizer` (iOS standaard spraaksynthese)
- Geen internetverbinding nodig
- Werkt volledig offline

**Voordelen:**
- Geen dataverbruik
- Werkt altijd, ongeacht internetverbinding
- Consistent gedrag

**Nadelen:**
- Stemkwaliteit kan variëren
- Afhankelijk van op het apparaat geïnstalleerde stemmen

### 3. TTSConfig.custom

Voor volledige controle over de spraakoutput:

```swift
// Eigen SpeechSynthesizing implementatie gebruiken
let customSpeechSynthesizer = MijnEigenSpeechSynthesizer()
let config = CoreConfig(ttsConfig: .custom(customSpeechSynthesizer))
```

**Kenmerken:**
- Ontwikkelaars kunnen hun eigen implementatie van het `SpeechSynthesizing` protocol leveren
- Volledige controle over spraakoutput
- Mogelijkheid om externe TTS-engines te integreren

**Use Cases:**
- Integratie met third-party TTS-services
- Custom stemprofielen
- Speciale audiobewerking of -effecten
- Integratie met bedrijfsspecifieke spraaktechnologie

---

## User Interface Lokalisatie

### Automatische UI-Taal

De gebruikersinterface van de Mapbox Navigation SDK past zich automatisch aan de taal van je applicatie aan. Voor de beste gebruikerservaring wordt aanbevolen om je applicatie volledig te lokaliseren.

### Turn Banner

De turn banner toont de naam van de aankomende weg of afrit in de lokale of nationale taal. In sommige regio's kan de naam in meerdere talen of schriften worden weergegeven.

### Afstanden en Tijden Overschrijven

Standaard worden afstanden, reistijden en aankomsttijden weergegeven volgens de systeemtaal en regio-instellingen. Om dit te overschrijven:

```swift
// Custom topBanner en bottomBanner configureren
let topBanner = TopBannerViewController()
topBanner.instructionsBannerView.distanceFormatter.locale = locale

let bottomBanner = BottomBannerViewController()
bottomBanner.distanceFormatter.locale = locale
bottomBanner.dateFormatter.locale = locale

let navigationOptions = NavigationOptions(
    mapboxNavigation: mapboxNavigation,
    voiceController: mapboxNavigationProvider.routeVoiceController,
    eventsManager: mapboxNavigationProvider.eventsManager(),
    topBanner: topBanner,
    bottomBanner: bottomBanner
)

let navigationViewController = NavigationViewController(
    navigationRoutes: navigationRoutes,
    navigationOptions: navigationOptions
)

// Delegates instellen voor custom banners
topBanner.delegate = navigationViewController
bottomBanner.delegate = navigationViewController
```

### Kaartlabels Lokaliseren

Standaard toont de kaart in `NavigationViewController` weglabels in de lokale taal, terwijl points of interest in de voorkeurstaal van het systeem worden weergegeven.

Voor een standalone `NavigationMapView`:

```swift
var cancellables: Set<AnyCancelable> = []

navigationMapView.mapView.mapboxMap.onStyleLoaded.observeNext { [weak self] _ in
    self?.navigationMapView?.localizeLabels()
}.store(in: &cancellables)
```

### Meetsysteem Overschrijven

Standaard gebruikt de SDK het dominante meetsysteem van de systeemregio. Om dit te overschrijven:

```swift
// Meetsysteem instellen bij routeberekening
routeOptions.distanceMeasurementSystem = .metric // of .imperial
```

---

## AVSpeechSynthesizer en Siri-Stem

### Over AVSpeechSynthesizer

`AVSpeechSynthesizer` is de ingebouwde spraaksynthese van iOS (ook bekend als VoiceOver). De Mapbox Navigation SDK kan deze gebruiken als:

- De Mapbox Voice API de gewenste taal niet ondersteunt
- Er geen internetverbinding is
- Je expliciet kiest voor `TTSConfig.localOnly`

### Beschikbare Stemmen

`AVSpeechSynthesizer` gebruikt de stemmen die op het iOS-apparaat beschikbaar zijn. Dit omvat:

- **Standaard iOS-stemmen**: Compact en Enhanced versies
- **Premium stemmen**: Gedownload via Instellingen > Toegankelijkheid > Gesproken inhoud
- **Siri-stemmen**: Mogelijk beschikbaar als iOS deze ondersteunt

### Siri-Stem Gebruiken

> ⚠️ **Belangrijk**: De officiële Mapbox-documentatie vermeldt **niet expliciet** dat je direct de Siri-stem kunt selecteren.

**Wat wel mogelijk is:**

1. **AVSpeechSynthesizer stemmen**: Je kunt stemmen selecteren die op het apparaat beschikbaar zijn
2. **Custom implementatie**: Via `TTSConfig.custom` kun je een eigen `SpeechSynthesizing` implementatie maken

**Voorbeeld van stem-selectie met AVSpeechSynthesizer:**

```swift
// Dit is een conceptueel voorbeeld voor een custom implementatie
import AVFoundation

class CustomSpeechSynthesizer: SpeechSynthesizing {
    let synthesizer = AVSpeechSynthesizer()
    
    func speak(_ text: String, locale: Locale) {
        let utterance = AVSpeechUtterance(string: text)
        
        // Beschikbare stemmen voor de locale ophalen
        let voices = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix(locale.languageCode ?? "") }
        
        // Premium/Enhanced stem selecteren indien beschikbaar
        if let premiumVoice = voices.first(where: { $0.quality == .enhanced }) {
            utterance.voice = premiumVoice
        } else if let defaultVoice = voices.first {
            utterance.voice = defaultVoice
        }
        
        synthesizer.speak(utterance)
    }
}
```

### Beperkingen

- Directe Siri-stem selectie wordt niet expliciet ondersteund in de documentatie
- Beschikbaarheid van stemmen varieert per iOS-versie en apparaat
- Sommige premium stemmen moeten handmatig worden gedownload door de gebruiker

---

## Ondersteunde Talen

De Mapbox Navigation SDK ondersteunt de volgende talen:

| Taal | User Interface | Gesproken Instructies | Opmerkingen |
|------|:--------------:|:--------------------:|-------------|
| Arabisch | ✅ | ✅ | Gebruikt VoiceOver |
| Birmaans | — | ✅ | Vereist third-party TTS |
| Catalaans | ✅ | — | |
| Chinees | ✅ (Vereenvoudigd) | ✅ (Mandarijn) | Gebruikt VoiceOver |
| Deens | ✅ | ✅ | |
| **Nederlands** | ✅ | ✅ | **Volledige ondersteuning** |
| Engels | ✅ | ✅ | |
| Esperanto | — | ✅ | Vereist third-party TTS |
| Fins | — | ✅ | Gebruikt VoiceOver |
| Frans | ✅ | ✅ | |
| Duits | ✅ | ✅ | |
| Grieks | ✅ | — | |
| Hebreeuws | ✅ | ✅ | Gebruikt VoiceOver |
| Hongaars | ✅ | ✅ | Gebruikt VoiceOver |
| Indonesisch | — | ✅ | Gebruikt VoiceOver |
| Italiaans | ✅ | ✅ | |
| Japans | ✅ | ✅ | |
| Koreaans | ✅ | ✅ | |
| Noors | — | ✅ | |
| Portugees | ✅ | ✅ | |
| Pools | ✅ | ✅ | |
| Roemeens | — | ✅ | |
| Russisch | ✅ | ✅ | |
| Sloveens | — | ✅ | Vereist third-party TTS |
| Spaans | ✅ | ✅ | |
| Zweeds | ✅ | ✅ | |
| Turks | ✅ | ✅ | |
| Oekraïens | ✅ | ✅ | Vereist third-party TTS |
| Vietnamees | ✅ | ✅ | Vereist third-party TTS |
| Yoruba | ✅ | ✅ | Vereist third-party TTS |

### Legenda

- ✅ = Ondersteund
- — = Niet ondersteund
- **VoiceOver**: Gebruikt iOS `AVSpeechSynthesizer` in plaats van Mapbox Voice API
- **Third-party TTS**: Vereist een third-party Text-to-Speech implementatie

---

## Samenvatting

### Belangrijkste Punten

1. **Spraaktaal wijzigen**: Ja, dit is mogelijk via de `NavigationRouteOptions.locale` property
   ```swift
   let routeOptions = NavigationRouteOptions(waypoints: waypoints, locale: Locale(identifier: "nl_NL"))
   ```

2. **TTS Configuratie Opties**:
   - `TTSConfig.default`: Mapbox Voice API met AVSpeechSynthesizer fallback
   - `TTSConfig.localOnly`: Alleen lokale AVSpeechSynthesizer
   - `TTSConfig.custom`: Eigen SpeechSynthesizing implementatie

3. **AVSpeechSynthesizer**: Biedt toegang tot lokale stemmen, inclusief mogelijk Siri-stemmen

4. **Siri-stem**: Directe selectie wordt **niet expliciet ondersteund** in de documentatie. Voor volledige stemcontrole moet je een eigen `SpeechSynthesizing` implementatie maken via `TTSConfig.custom`

5. **Nederlandse Taal**: Volledig ondersteund voor zowel UI als gesproken instructies

### Best Practices

- Lokaliseer je applicatie volledig voor de beste gebruikerservaring
- Test gesproken instructies in alle ondersteunde talen
- Overweeg `TTSConfig.localOnly` voor offline-first applicaties
- Gebruik `TTSConfig.custom` alleen als je specifieke stemvereisten hebt

---

## Bronverwijzingen

### Officiële Documentatie

- [Localization and internationalization](https://docs.mapbox.com/ios/navigation/guides/system-integration/localization-and-internationalization/) - Volledige lokalisatiegids
- [Spoken instructions](https://docs.mapbox.com/ios/navigation/guides/system-integration/localization-and-internationalization/#spoken-instructions) - Gedetailleerde informatie over gesproken instructies
- [Spoken instruction override](https://docs.mapbox.com/ios/navigation/guides/turn-by-turn-navigation/user-interface/#spoken-instruction-override) - Custom spraakimplementaties

### Gerelateerde Bronnen

- [Mapbox Navigation SDK for iOS](https://docs.mapbox.com/ios/navigation/guides/)
- [Apple AVSpeechSynthesizer Documentation](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer)
- [Localize your app (Apple Developer)](https://developer.apple.com/documentation/xcode/localization)

---

*Laatste update: 2025*

*Deze documentatie is gebaseerd op de Mapbox Navigation SDK v3 voor iOS.*
