# The middleware's image: a static Go binary on a minimal base (no shell, no package manager, non-root user).
# Bases pinned by digest: a rebuild gives the same image until they are updated on purpose.

FROM golang:1.27.3-alpine@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
# Static binary (no C library needed), without paths of the build machine nor debug symbols
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/middleware .

FROM gcr.io/distroless/static-debian13:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329
LABEL org.opencontainers.image.source=https://github.com/NicolasGresset/rendez-vous
COPY --from=build /out/middleware /middleware
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/middleware"]
