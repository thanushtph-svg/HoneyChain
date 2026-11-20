"""Spectral preprocessing shared by training and serving (must be importable by joblib)."""
import numpy as np


def snv(X):
    """Standard Normal Variate: centre and scale every spectrum (row) individually.
    Removes multiplicative scatter/brightness differences between acquisitions."""
    X = np.asarray(X, dtype=float)
    mu = X.mean(axis=1, keepdims=True)
    sd = X.std(axis=1, keepdims=True)
    sd[sd == 0] = 1.0
    return (X - mu) / sd


def snv_first_derivative(X):
    """SNV followed by the first derivative along the wavelength axis (emphasises band shape)."""
    return np.gradient(snv(X), axis=1)


def identity(X):
    return np.asarray(X, dtype=float)
