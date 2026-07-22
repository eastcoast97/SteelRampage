/** Resolve a public/ asset path against the build's base URL, so runtime
 *  fetches work when the site is mounted under a subpath (GitHub Pages
 *  serves at /SteelRampage/, Render at /). Pass paths WITHOUT a leading
 *  slash: assetUrl('models/arena.glb'). */
export const assetUrl = (path: string): string => import.meta.env.BASE_URL + path;
