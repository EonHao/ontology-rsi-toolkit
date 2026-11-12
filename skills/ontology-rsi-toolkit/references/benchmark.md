# Resolve the published Benchmark

Read the selected Project's `benchmark_config.toml` and Case `statement/README.md`, then the linked repository README, public task manifest and adapter documentation. These define task paths, input access, feedback, scoring, exports and runtime limits. This toolkit defines the learning procedure.

Resolve the matching Train/Test packages, the continuous training entry point and its member questions, native trial/result locations, the State import contract, the model connection and executable installation. For repository-backed tasks, require the full 40-character lowercase commit in the statement; the Task link, run-rules link and checkout instruction must name the same commit. Record the repository URL and commit, fetch that checkout once, then use it for training and every baseline and final test repetition. A user-specified version selects a matching package; do not substitute a branch, tag or task revision beneath the installed statements.

A Train package can expose one Case containing several questions. That is one continuous training invocation. Resolve its member tasks and independent Test Cases from the published instructions rather than constructing paths from names. Build the Ontologist's brief from learner-facing inputs and the permitted feedback interface. Grader source, rubrics and reference answers are not training material, and nothing derived from them may enter the corpus.

## Runtime and handoff

Use the documented runner and adapter. Training requires a continuing Ontologist session, fresh Actor child sessions in the same business environment, readable Actor Traces in the container's data root, and the judge feedback the benchmark exposes for training. If this contract is unavailable, report the incompatibility rather than replacing it with independent reset trials.

Apply the benchmark's time, turn and network settings. Unlimited turns do not remove a wall-clock cap. Keep trial concurrency distinct from physical container capacity: count runner sidecars as well as business containers. Training and testing share the available capacity.

Collect native artifacts before creating frozen test States. A combined Train/Test job does not transfer the learned slot automatically. The final training verifier scores the exported answers; the per-pass measurements come from the Ontologist's records. Preserve both.

Follow the repository's retry rules and keep failed attempts. A run that has already begun solving is not an unused attempt; any exception needs the user's authorization unless the experiment policy already covers it.
