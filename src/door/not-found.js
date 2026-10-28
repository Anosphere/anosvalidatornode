/**
 * Runs when no route matched. Mounted after all routers: here, after the
 * door's table, so any path or method that is not in it (the worker's GET /
 * greeting included) is answered at the door and never forwarded.
 * A copy of anossoftware's src/middleware/not-found.js.
 */
export function notFound(req, res) {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
}
