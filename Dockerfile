# syntax=docker/dockerfile:1

ARG RUST_VERSION=1.97.1

FROM rust:${RUST_VERSION}-bookworm AS wasm-builder
WORKDIR /src

COPY Cargo.lock ./
RUN rustup target add wasm32-unknown-unknown
RUN WASM_BINDGEN_VERSION="$(sed -n '/^name = "wasm-bindgen"$/,/^version/s/^version = "\(.*\)"/\1/p' Cargo.lock | head -1)" \
    && cargo install wasm-bindgen-cli --version "${WASM_BINDGEN_VERSION}" --locked

COPY . .
RUN ./tools/build-wasm.sh

FROM node:24-bookworm-slim AS web-builder
WORKDIR /src

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY --from=wasm-builder /src/packages/player/wasm ./packages/player/wasm

RUN npm ci
RUN npm run web:build

FROM nginx:1.30.4-alpine
COPY --from=web-builder /src/dist /usr/share/nginx/html

EXPOSE 80
