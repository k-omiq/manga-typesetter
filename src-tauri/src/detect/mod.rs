//! Detection in Rust, via ONNX Runtime.
//!
//! This module is the replacement for the Python sidecar. See
//! `docs/superpowers/specs/2026-08-16-onnx-sidecar-removal-design.md` for why
//! and for the slice order; the short version is that the sidecar is 1.7 GB of
//! Python shipped to run three neural networks, all three of which have
//! published ONNX exports that ONNX Runtime can run from here with no Python at
//! all.
//!
//! Slice 1 was the manga109 panel detector — the smallest of the three, and the
//! one that proved the parts every later slice needs: linking ONNX Runtime,
//! preparing an image, reading a model's output tensor, and mapping predictions
//! back onto page coordinates. `textdetector` and `ocr` followed.
//!
//! `crops`, `analyze` and `engine` close the loop. `crops` turns detected blocks
//! into the images manga-ocr reads, `analyze` is the whole `/analyze` route in
//! one function, and `engine` holds the lazily-loaded sessions and exposes the
//! Tauri commands that replace the sidecar's HTTP surface.

pub mod analyze;
pub mod crops;
pub mod cvops;
pub mod dbnet;
pub mod engine;
pub mod geometry;
pub mod minrect;
pub mod ocr;
pub mod panels;
pub mod sorting;
pub mod textblock;
pub mod textdetector;
