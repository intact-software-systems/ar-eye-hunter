# Rallar Motion Guide

Rallar Motion interpolates snapshots the browser has already received, and it
gates how often a client sends a high-rate pose. It does not own simulation,
collision, scoring, or match authority.

`docs/architecture.md` records why Motion is not the simulation.

## When to use it

Use Motion when the user should see smooth motion between updates that arrive
late, early, or in bursts: remote avatars, cursors, and other presentation
poses.

Do not use Motion for:

- the authoritative position, score, or match result
- collision or other simulation steps
- durable room membership or event history

## Where the recipe lives

The browser setup is the "Rallar Motion Smoothing" section of
`docs/rallar-quickstart-and-recipes.md`. The smallest copyable sample is
`examples/motion-smoothing/README.md`. Motion consumes poses that arrive on a
realtime data channel. It does not choose that channel. The plane choice is in
`docs/architecture.md`.
