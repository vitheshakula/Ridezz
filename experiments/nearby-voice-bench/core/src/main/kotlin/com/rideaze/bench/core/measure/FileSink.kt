package com.rideaze.bench.core.measure

import java.io.BufferedWriter
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStreamWriter

/**
 * JSONL file in the app's own external files dir (adb-pullable, removed on uninstall).
 * Opened lazily on the first write, so an attempt that never starts leaves no empty file.
 * NEVER overwrites: if the file already exists the write fails loudly instead of destroying earlier evidence.
 */
class FileSink(val file: File) : LineSink {
    private var w: BufferedWriter? = null
    private var closed = false

    private fun open(): BufferedWriter {
        file.parentFile?.mkdirs()
        if (!file.createNewFile()) throw IOException("refusing to overwrite existing result file ${file.name}")
        return BufferedWriter(OutputStreamWriter(FileOutputStream(file, false), Charsets.UTF_8), 64 * 1024).also { w = it }
    }

    @Synchronized override fun write(line: String) {
        if (closed) return
        val out = w ?: open()
        out.write(line); out.write("\n")
    }
    @Synchronized override fun flush() { if (!closed) w?.flush() }
    @Synchronized override fun close() { if (!closed) { w?.flush(); w?.close(); closed = true } }
}
