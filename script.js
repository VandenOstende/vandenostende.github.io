// ============================================
// TOEGANGSBEHEER FUNCTIONALITEIT
// ============================================

/**
 * Render alle apps (iedereen kan ze zien)
 */
function renderAllApps() {
    const appsGrid = document.getElementById('apps-grid');
    appsGrid.innerHTML = '';
    
    // Toon alle apps
    for (const [appId, appConfig] of Object.entries(ACCESS_CONFIG.apps)) {
        const app = { id: appId, ...appConfig };
        const appCard = createAppCard(app);
        appsGrid.appendChild(appCard);
    }
    
    // Voeg "Meer apps binnenkort" kaart toe
    const placeholderCard = createPlaceholderCard();
    appsGrid.appendChild(placeholderCard);
    
    // Observeer de nieuwe cards voor animatie
    observeAppCards();
}

/**
 * Maak een app kaart element
 */
function createAppCard(app) {
    const card = document.createElement('div');
    card.className = 'app-card';
    card.style.opacity = '0';
    
    const icon = app.icon || '📱';
    
    card.innerHTML = `
        <div class="app-card-content">
            <span class="app-icon">${icon}</span>
            <h3>${app.name}</h3>
            <p>${app.description}</p>
            <span class="app-status">Beschikbaar</span>
            <br><br>
            <button class="cta-button open-app-btn" data-app-id="${app.id}" data-app-url="${app.url}">
                Open App →
            </button>
        </div>
    `;
    
    // Click handler voor de "Open App" knop
    const openBtn = card.querySelector('.open-app-btn');
    openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showEmailPrompt(app.id, app.url, app.name);
    });
    
    return card;
}

/**
 * Maak placeholder kaart voor toekomstige apps
 */
function createPlaceholderCard() {
    const card = document.createElement('div');
    card.className = 'app-card';
    card.style.opacity = '0';
    card.innerHTML = `
        <div class="app-card-content">
            <span class="app-icon">✨</span>
            <h3>Meer Apps Binnenkort</h3>
            <p>Dit platform is nog in ontwikkeling. En dus komen er andere apps in de nabije toekomst.</p>
            <span class="app-status" style="border-color: #94a3b8; color: #94a3b8;">Binnenkort</span>
        </div>
    `;
    return card;
}

/**
 * Toon email prompt voor toegangscontrole
 */
function showEmailPrompt(appId, appUrl, appName) {
    // Controleer of cookies geaccepteerd zijn
    const cookieConsent = localStorage.getItem('cookieConsent');
    
    // Haal opgeslagen email op uit localStorage (alleen als geaccepteerd)
    const savedEmail = (cookieConsent === 'accepted') ? (localStorage.getItem('userEmail') || '') : '';
    
    // Maak modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>🔐 Toegang tot ${appName}</h3>
                <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
            </div>
            <div class="modal-body">
                <p style="color: var(--text-secondary); margin-bottom: 1rem;">
                    Voer je emailadres in om toegang te krijgen tot deze applicatie.
                </p>
                <div class="modal-tags" style="margin-bottom: 1rem;">
                    <p style="font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 0.5rem;">
                        Vereiste toegangstags:
                    </p>
                    ${ACCESS_CONFIG.apps[appId].requiredTags.map(tag => {
                        const tagConfig = ACCESS_CONFIG.tags[tag] || { color: '#64748b' };
                        return `<span class="app-tag" style="background-color: ${tagConfig.color}20; color: ${tagConfig.color}; border: 1px solid ${tagConfig.color}40;">${tag}</span>`;
                    }).join(' ')}
                </div>
                <input 
                    type="email" 
                    id="email-input" 
                    placeholder="jouw.naam@bedrijf.com"
                    class="email-input"
                    value="${savedEmail}"
                />
                <label style="display: flex; align-items: center; gap: 0.5rem; color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1rem; cursor: pointer;">
                    <input 
                        type="checkbox" 
                        id="remember-email" 
                        ${savedEmail ? 'checked' : ''}
                        style="cursor: pointer;"
                    />
                    Onthoud mijn emailadres
                </label>
                <div id="access-message" class="access-message" style="display: none;"></div>
                <div class="modal-actions">
                    <button class="modal-btn modal-btn-secondary" onclick="this.closest('.modal-overlay').remove()">
                        Annuleren
                    </button>
                    <button class="modal-btn modal-btn-primary" onclick="checkAccess('${appId}', '${appUrl}')">
                        Toegang Controleren
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(overlay);
    
    // Focus op input veld
    setTimeout(() => {
        const emailInput = document.getElementById('email-input');
        emailInput.focus();
        // Plaats cursor aan het einde als er al een email is
        if (savedEmail) {
            emailInput.setSelectionRange(savedEmail.length, savedEmail.length);
        }
    }, 100);
    
    // Enter key om te submitten
    document.getElementById('email-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            checkAccess(appId, appUrl);
        }
    });
}

/**
 * Controleer toegang voor een gebruiker
 */
function checkAccess(appId, appUrl) {
    const emailInput = document.getElementById('email-input');
    const email = emailInput.value.trim().toLowerCase();
    const messageDiv = document.getElementById('access-message');
    const rememberCheckbox = document.getElementById('remember-email');
    
    // Valideer email formaat
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
        messageDiv.style.display = 'block';
        messageDiv.className = 'access-message error';
        messageDiv.innerHTML = '❌ Voer een geldig emailadres in';
        return;
    }
    
    // Sla email op of verwijder uit localStorage op basis van checkbox
    // Alleen opslaan als cookies geaccepteerd zijn
    const cookieConsent = localStorage.getItem('cookieConsent');
    if (rememberCheckbox.checked && cookieConsent === 'accepted') {
        localStorage.setItem('userEmail', email);
    } else {
        localStorage.removeItem('userEmail');
    }
    
    // Controleer toegang
    if (hasAccess(email, appId)) {
        const userTags = getUserTags(email);
        messageDiv.style.display = 'block';
        messageDiv.className = 'access-message success';
        messageDiv.innerHTML = `
            ✅ Toegang verleend!<br>
            <small>Jouw tags: ${userTags.join(', ')}</small>
        `;
        
        // Redirect na 1.5 seconden
        setTimeout(() => {
            window.location.href = appUrl;
        }, 1500);
    } else {
        messageDiv.style.display = 'block';
        messageDiv.className = 'access-message error';
        messageDiv.innerHTML = '❌ Geen toegang. Je hebt niet de vereiste tags voor deze applicatie.';
    }
}

/**
 * Observeer app cards voor animatie bij scroll
 */
function observeAppCards() {
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -100px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.animation = 'fadeInUp 0.6s ease-out forwards';
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    const appCards = document.querySelectorAll('.app-card');
    appCards.forEach(card => {
        observer.observe(card);
    });
}

// ============================================
// INITIALISATIE EN ALGEMENE FUNCTIONALITEIT
// ============================================

/**
 * Controleer en toon cookie banner
 */
function checkCookieConsent() {
    // Toon de banner altijd bij elke pagina herlading
    const banner = document.getElementById('cookie-banner');
    if (banner) {
        setTimeout(() => {
            banner.style.display = 'block';
            banner.style.animation = 'slideUpBanner 0.5s ease-out forwards';
        }, 1000);
    }
}

/**
 * Accepteer cookies
 */
function acceptCookies() {
    localStorage.setItem('cookieConsent', 'accepted');
    hideCookieBanner();
}

/**
 * Weiger cookies
 */
function declineCookies() {
    localStorage.setItem('cookieConsent', 'declined');
    // Verwijder opgeslagen email als cookies geweigerd worden
    localStorage.removeItem('userEmail');
    hideCookieBanner();
}

/**
 * Verberg cookie banner
 */
function hideCookieBanner() {
    const banner = document.getElementById('cookie-banner');
    if (banner) {
        banner.style.animation = 'slideDownBanner 0.5s ease-out forwards';
        setTimeout(() => {
            banner.style.display = 'none';
        }, 500);
    }
}

/**
 * Initialiseer de applicatie
 */
function initializeApp() {
    // Render alle apps (iedereen kan ze zien)
    renderAllApps();
    
    // Controleer cookie consent
    checkCookieConsent();
}

// Smooth scroll functionaliteit
document.addEventListener('DOMContentLoaded', () => {
    // Initialiseer de app met toegangsbeheer
    initializeApp();
    
    // Smooth scroll voor navigatie links
    const navLinks = document.querySelectorAll('a[href^="#"]');
    
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            const targetId = link.getAttribute('href');
            if (targetId === '#') return;
            
            e.preventDefault();
            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                targetElement.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });

    // Parallax effect voor floating shapes
    let mouseX = 0;
    let mouseY = 0;
    let currentX = 0;
    let currentY = 0;

    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX / window.innerWidth - 0.5;
        mouseY = e.clientY / window.innerHeight - 0.5;
    });

    function animate() {
        // Smooth follow effect
        currentX += (mouseX - currentX) * 0.1;
        currentY += (mouseY - currentY) * 0.1;

        const shapes = document.querySelectorAll('.floating-shape');
        shapes.forEach((shape, index) => {
            const speed = (index + 1) * 20;
            shape.style.transform = `translate(${currentX * speed}px, ${currentY * speed}px)`;
        });

        requestAnimationFrame(animate);
    }

    animate();

    // Header styling bij scrollen
    const header = document.querySelector('header');
    let lastScroll = 0;

    window.addEventListener('scroll', () => {
        const currentScroll = window.pageYOffset;

        if (currentScroll > 100) {
            header.style.background = 'rgba(30, 41, 59, 0.95)';
            header.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.3)';
        } else {
            header.style.background = 'rgba(30, 41, 59, 0.3)';
            header.style.boxShadow = 'none';
        }

        lastScroll = currentScroll;
    });
});
