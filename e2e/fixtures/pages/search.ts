// A tiny fixture page the agent can interact with in E2E tests.
// Loaded at `http://localhost:<port>/e2e/fixtures/pages/search.html`.

import { type Page, serveFixture } from './serve';

export const searchHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Fixture: Search</title>
  </head>
  <body style="font-family: system-ui; max-width: 600px; margin: 2rem auto; padding: 0 1rem;">
    <h1 data-testid="page-title">Fixture Search Page</h1>
    <p>Type a query and click search. The result count updates below.</p>
    <input
      id="search-input"
      type="text"
      data-testid="search-input"
      placeholder="Search…"
      style="padding: 6px 10px; font-size: 14px; width: 240px;"
    />
    <button
      id="search-button"
      data-testid="search-button"
      style="padding: 6px 12px; margin-left: 4px;"
    >
      Search
    </button>
    <p id="status" data-testid="status" style="margin-top: 1rem; color: #555;">
      idle
    </p>
    <script>
      const input = document.getElementById('search-input');
      const button = document.getElementById('search-button');
      const status = document.getElementById('status');
      button.addEventListener('click', () => {
        const q = (input.value || '').trim();
        if (!q) {
          status.textContent = 'no query';
          return;
        }
        status.dataset.state = 'searched';
        status.textContent = 'searched for: ' + q;
      });
    </script>
  </body>
</html>
`;
