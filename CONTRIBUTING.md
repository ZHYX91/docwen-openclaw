# Contributing

Open an issue before adding or changing a tool. Each tool needs a clear user problem, permission class,
typed input and output, DocWen CLI mapping, timeout, cancellation behavior, and file-write boundary.

Use a topic branch and run `npm run check`. Changes to the manifest, package layout, tool catalog, process
runner, or Machine Protocol also require tarball and OpenClaw runtime verification. Never commit private files,
absolute paths, Gateway configuration, credentials, caches, build output, or maintainer plans.

Pull requests should state the supported OpenClaw and DocWen versions, tests run, write side effects, and
real Gateway acceptance that remains pending. Contributions are licensed under the repository's MIT license.
