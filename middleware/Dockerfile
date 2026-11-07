# The middleware's image: a static Go binary and the places file, on a minimal base (no shell, no package manager,
# non-root user). Built from the repository's root (`docker build -f middleware/Dockerfile .`), since the places file
# lives in data/; .dockerignore keeps the context to what is needed.
# Bases pinned by digest: a rebuild gives the same image until they are updated on purpose.

FROM golang:1.27.3-alpine@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS build
WORKDIR /src
COPY middleware/go.mod ./
COPY middleware/*.go ./
# Static binary (no C library needed), without paths of the build machine nor debug symbols
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/middleware .

FROM gcr.io/distroless/static-debian13:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329
LABEL org.opencontainers.image.source=https://github.com/NicolasGresset/rendez-vous
COPY --from=build /out/middleware /middleware
# The data the algorithms were tested on goes with the code (docs/architecture.md § Deployment of the middleware)
COPY data/pois-toulouse.json /places.json
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/middleware"]
