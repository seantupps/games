"""Build Cython extension for GOPS Nash hot path.

Requires MSVC on PATH (run from a Developer Command Prompt), e.g.:

  call "D:\\Development\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat"
  set DISTUTILS_USE_SDK=1
  set MSSdk=1
  python setup_cython.py build_ext --inplace
"""

from __future__ import annotations

import os
from pathlib import Path

from Cython.Build import cythonize
from setuptools import Extension, setup

# setuptools otherwise ignores a vcvars-activated cl.exe on some Windows setups
os.environ.setdefault("DISTUTILS_USE_SDK", "1")
os.environ.setdefault("MSSdk", "1")

HERE = Path(__file__).resolve().parent

ext = Extension(
    "solve_value",
    sources=[str(HERE / "solve_value.pyx")],
)

setup(
    name="gops_solve_value",
    ext_modules=cythonize(
        [ext],
        language_level="3",
        compiler_directives={
            "boundscheck": False,
            "wraparound": False,
            "cdivision": True,
        },
    ),
)
