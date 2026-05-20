# Bottle Info Uses Host App Origin

Bottle's info contract should advertise the Host App identity as `hostAppOrigin`, not `mainAppUrl`. The value is an origin used for attachment identity and Bottle base URL derivation, so the old name incorrectly suggests an arbitrary app URL with path semantics and preserves the deprecated "main app" language.
