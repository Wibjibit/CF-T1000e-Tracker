# Build stage: full rust image (has the C toolchain).
FROM rust:1-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

# Runtime: debian-slim + CA certs (reqwest's rustls bundles webpki roots, but
# certs cost nothing and remove a failure mode). musl-static -> scratch is a
# later image-size optimization.
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/spot-relay /usr/local/bin/spot-relay
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/spot-relay"]
