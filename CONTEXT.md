# Bottle

Bottle is an agent runtime that attaches to an existing application so AI clients can work with that application's live context without Bottle becoming the application itself.

## Language

**Host App**:
The application Bottle is attached to and whose user-facing domain Bottle helps inspect or operate. The Host App is the product or prototype being assisted, not Bottle and not the AI-facing wrapper; it may be web-based or API-based.
_Avoid_: Main app, parent app, wrapped app, bottled host

**Web Host App**:
A Host App with browser-rendered pages that can provide live visual and navigation context to an AI Client through Bottle.
_Avoid_: UI app

**API Host App**:
A Host App whose primary surface is an API rather than browser-rendered pages. It can use Bottle's session API without necessarily providing iframe context.
_Avoid_: Headless app

**Attached Bottle Runtime**:
A Bottle runtime associated with exactly one Host App, reached through the Host App's public boundary rather than replacing the Host App as the application runtime.
_Avoid_: Standalone app runtime, primary app runtime

**Host App Public Origin**:
The browser-facing origin where the Host App is reached and where Bottle's public contract appears. The attached Bottle runtime may run on another port internally, but browser-facing Bottle routes belong under this origin.
_Avoid_: Bottle origin, wrapper origin

**Selected Host App Origin**:
The Host App Public Origin chosen by a user in an AI Client Integration for a particular session. It is normalized to an origin, and the AI Client Integration uses it to reach Bottle's public contract for that Host App.
_Avoid_: AI Client origin, internal Bottle port

**Initial Host App Route**:
The path, query, and fragment the user wants to open first inside a Web Host App's Bottle iframe surface. It is separate from the Selected Host App Origin used to locate Bottle.
_Avoid_: Bottle base URL, Host App origin

**Iframe Bridge**:
The browser messaging contract that lets an AI Client request live context from a Web Host App rendered through Bottle's iframe surface.
_Avoid_: Post event bridge, injected proxy

**Iframe Route Mapping**:
The rule that maps an Initial Host App Route onto Bottle's iframe surface by placing the same route under `/__bottle/iframe`. The Bottle API base remains under `/__bottle/v1`.
_Avoid_: App proxy path, iframe base URL

**Bridge Injection**:
The act of adding the Iframe Bridge to a Web Host App HTML response when that page is served through Bottle's iframe surface. Bridge Injection is a delivery mechanism for the Iframe Bridge, not the bridge contract itself.
_Avoid_: Bridge protocol, iframe proxy

**Standalone Initialization**:
The setup flow that prepares Bottle independently of the Host App's own build and server process. This describes how Bottle is installed or packaged, not whether Bottle is the public application.
_Avoid_: Standalone app, standalone public runtime

**AI Client**:
The user-facing tool that talks to Bottle in order to create sessions, stream agent responses, and request live Host App context. An AI Client may be embedded in a Host App Integration.
_Avoid_: Host, main app

**Agent Provider**:
The selected assistant runtime implementation Bottle delegates a session to. Provider names such as `claude` and `codex` identify concrete implementations; Bottle's public concepts should stay provider-neutral unless they are selecting or configuring a specific provider.
_Avoid_: Claude as a generic term, Codex as a generic term

**AI Client Integration**:
Application-specific glue that lets an AI Client communicate with an attached Bottle runtime through the shared Bottle contract. `ai-prototype-wrapper` is one AI Client Integration, not the Host App itself and not the canonical name for all integrations.
_Avoid_: Host App Integration, wrapper as a generic term, bottled host

**Attachment Handshake**:
The initial check an AI Client Integration performs against a Selected Host App Origin to confirm that a compatible attached Bottle runtime is present for that Host App. The Selected Host App Origin is the authority for Host App identity; Bottle's display name is metadata, not identity.
_Avoid_: Login check, health check, direct port check

## Example Dialogue

Developer: After standalone initialization, can Bottle serve the product by itself?

Domain expert: No. Standalone initialization only prepares Bottle. The product remains the Host App, and Bottle runs as an attached Bottle runtime.

Developer: Does that change if the Host App is API-based?

Domain expert: No. Bottle still attaches to the Host App; an API-based Host App simply has no browser UI for Bottle to inspect directly.

Developer: Is `ai-prototype-wrapper` part of Bottle's core model?

Domain expert: No. It is one AI Client Integration that can communicate with an attached Bottle runtime.

Developer: In a setup with `my-prototype`, Bottle, and `ai-prototype-wrapper`, which one is the Host App?

Domain expert: `my-prototype` is the Host App. Bottle is the attached Bottle runtime. `ai-prototype-wrapper` is an AI Client Integration.

Developer: Where should browser-facing Bottle routes appear?

Domain expert: Under the Host App Public Origin. The attached Bottle runtime can listen on its own internal port, but the browser should reach Bottle through the Host App's public boundary.

Developer: If a user opens `ai-prototype-wrapper` and enters `https://prototype.example.com`, where does the AI Client Integration talk to Bottle?

Domain expert: It talks to Bottle under the Selected Host App Origin, such as `https://prototype.example.com/__bottle`.

Developer: If the user enters `https://prototype.example.com/dashboard?tab=a`, what is the Selected Host App Origin?

Domain expert: `https://prototype.example.com`. `/dashboard?tab=a` is the Initial Host App Route.

Developer: What iframe URL should an AI Client Integration use for that route?

Domain expert: `https://prototype.example.com/__bottle/iframe/dashboard?tab=a`.

Developer: How does an AI Client Integration know the selected Host App has Bottle attached?

Domain expert: It performs an Attachment Handshake against the Selected Host App Origin before creating sessions or opening iframe routes.

Developer: Should Bottle call generic commands or modes "Claude" or "Codex" concepts?

Domain expert: No. Those names are Agent Providers. Bottle commands, modes, sessions, and web chat contracts are provider-neutral.

Developer: Can an API Host App still attach Bottle?

Domain expert: Yes. It uses Bottle's session API even if there is no meaningful browser page for iframe context.

Developer: If a Web Host App already includes the bridge script itself, does Bottle still use the Iframe Bridge?

Domain expert: Yes. Bridge Injection can be skipped, but the Iframe Bridge contract is still the same.
