# stitchd — custom GPU compositor for restitch.
# Links our own libav* (static, from the ffmpeg-builder stage / stitchd-dev
# image at /opt/ffmpeg) for RTSP I/O + NVDEC/NVENC; all compositing is our
# own CUDA. See plans/custom-compositor.md.
cmake_minimum_required(VERSION 3.24)
project(stitchd LANGUAGES CXX CUDA)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CUDA_STANDARD 17)
set(CMAKE_CUDA_ARCHITECTURES 89) # Ada / RTX 4090 (sm_89)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# --- libav* (our build) via pkg-config; static ---
find_package(PkgConfig REQUIRED)
set(ENV{PKG_CONFIG_PATH} "/opt/ffmpeg/lib/pkgconfig")
pkg_check_modules(LIBAV REQUIRED IMPORTED_TARGET
  libavformat libavcodec libavutil libswresample)
# Static libav pulls transitive system deps; pkg-config --static resolves them.
pkg_check_modules(LIBAV_STATIC REQUIRED
  libavformat libavcodec libavutil libswresample)

# --- CUDA runtime + NPP (from the CUDA devel image) ---
find_package(CUDAToolkit REQUIRED)

file(GLOB STITCHD_SOURCES CONFIGURE_DEPENDS
  "${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/*.cu")

add_executable(stitchd ${STITCHD_SOURCES})

target_include_directories(stitchd PRIVATE
  ${LIBAV_INCLUDE_DIRS}
  ${CMAKE_CURRENT_SOURCE_DIR}/src)

# Link the static libav archives + their transitive deps, then CUDA/NPP.
target_link_directories(stitchd PRIVATE ${LIBAV_STATIC_LIBRARY_DIRS})
target_link_libraries(stitchd PRIVATE
  ${LIBAV_STATIC_STATIC_LIBRARIES}
  CUDA::cudart
  CUDA::nppc CUDA::nppig CUDA::nppidei CUDA::nppicc
  pthread m dl)
