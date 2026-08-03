# Synthetic plugin test point

`synthetic-render` and `synthetic-draw` are deterministic example plugins used to
test HawkSpan's generic application-plugin boundary. They are not core
features and do not depend on third-party applications.

Both plugins are worker-only and peer-only. A typical asymmetric test installs
them only on the lower-value worker Mac, configures the other Mac as a
controller, adds their generated names to the controller's
`peer.allowed_tools`, and invokes:

- `app_synthetic_render_render` to create a title-card SVG;
- `app_synthetic_draw_draw` to create a shape SVG.

Successful results include durable plugin runs and registered SVG artifacts.
The test verifies discovery, strict input schemas, controller/worker roles,
peer-origin restrictions, execution, and artifact handling. The example
plugins do not launch applications, access the network, or write outside their
HawkSpan-owned plugin state directories.
