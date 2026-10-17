import { h } from '../app.js';

/**
 * Placeholder for the Queryable Encryption feature (customers + payment cards
 * of the same store). To merge it:
 *  1. server: add src/server/routes/qe.ts exporting `qeRouter` and mount it
 *     in the `features` list in src/server/index.ts (/api/qe)
 *  2. data: use a `customers` collection in the same DB_NAME; orders already
 *     reference customers by `customerId` (1..250000)
 *  3. UI: replace this file's render() - the tab is already registered in js/app.js
 */
export default {
  id: 'queryable-encryption',
  title: 'Queryable Encryption',
  tag: 'merge',
  render(el) {
    el.append(h('div', { class: 'card' },
      h('h2', {}, 'Queryable Encryption'),
      h('p', { class: 'ink2' }, 'Reserved for the Queryable Encryption demo: a small customers collection holding encrypted payment-card data for this store, queried with equality/range on encrypted fields.'),
      h('div', { class: 'callout' },
        h('strong', {}, 'Merge points'),
        h('ul', {},
          h('li', {}, 'Server: mount a router at /api/qe in src/server/index.ts (see the features list).'),
          h('li', {}, 'Data: customers live in the same database; orders.customerId (1–250,000) is the join key.'),
          h('li', {}, 'UI: replace public/js/tabs/queryable-encryption.js - the tab is already registered.'),
        ),
      ),
    ));
  },
};
