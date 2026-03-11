import { Hono } from 'jsr:@hono/hono';
import { computeGlobalGraphAndCacheIt, computeGroupGraph } from '@shared-graph/group-graphs-create-service.ts';

export function init(app: Hono) {
    app.get(
        '/api/graph',
        c => {
            return c.json(computeGlobalGraphAndCacheIt());
        }
    );

    app.get(
        '/api/graph/tree/:groupId',
        c => {
            const groupId = c.req.param('groupId');

            const computedGraph =
                computeGroupGraph(
                    groupId,
                    true
                );

            if (computedGraph.left) {
                return c.json(
                    {
                        error: computedGraph.left
                    },
                    400
                );
            }

            return c.json(computedGraph.right);
        }
    );
}
