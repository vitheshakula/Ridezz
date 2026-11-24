package com.rideaze.bench

import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import com.rideaze.bench.core.pairing.PairRole
import com.rideaze.bench.core.platform.PermissionPlan
import com.rideaze.bench.core.run.Scenarios
import com.rideaze.bench.run.RunController

/** Operator screen. Programmatic layout (no resources) to keep the experiment self-contained. */
class BenchActivity : Activity() {
    private val ui = Handler(Looper.getMainLooper())
    private lateinit var controller: RunController
    private lateinit var status: TextView
    private lateinit var digitsRow: View
    private lateinit var digitsText: TextView
    private lateinit var spinner: Spinner
    private lateinit var label: EditText
    private lateinit var runIdx: EditText
    private lateinit var roleSender: RadioButton

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) // E1 is run screen-on
        controller = (application as BenchApp).controller

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24) }
        fun btn(t: String, a: () -> Unit) = Button(this).apply { text = t; setOnClickListener { a() } }.also { root.addView(it) }

        root.addView(TextView(this).apply { text = "Rideaze Bench - E1 BYTES (experiment, not the product)"; textSize = 16f; setTypeface(null, Typeface.BOLD) })
        btn("1. Grant permissions") { requestMissing() }
        spinner = Spinner(this).apply { adapter = ArrayAdapter(this@BenchActivity, android.R.layout.simple_spinner_dropdown_item, Scenarios.e1BytesMatrix.map { it.id }) }
        root.addView(spinner)
        label = EditText(this).apply { hint = "session label (1-8 letters/digits, same on both phones)"; setText("A1") }
        runIdx = EditText(this).apply { hint = "run index 0-15 (same on both phones)"; inputType = InputType.TYPE_CLASS_NUMBER; setText("0") }
        root.addView(label); root.addView(runIdx)
        val group = RadioGroup(this).apply { orientation = RadioGroup.HORIZONTAL }
        roleSender = RadioButton(this).apply { text = "SENDER"; isChecked = true }
        group.addView(roleSender); group.addView(RadioButton(this).apply { text = "RECEIVER" }); root.addView(group)
        btn("2. Start pairing (60 s window)") { onPair() }
        digitsText = TextView(this).apply { textSize = 22f; setTypeface(Typeface.MONOSPACE, Typeface.BOLD) }
        digitsRow = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; visibility = View.GONE
            addView(digitsText)
            addView(Button(this@BenchActivity).apply { text = "Digits MATCH the other phone"; setOnClickListener { controller.confirmDigits(true) } })
            addView(Button(this@BenchActivity).apply { text = "Digits DIFFER"; setOnClickListener { controller.confirmDigits(false) } })
        }
        root.addView(digitsRow)
        btn("3. Start run (when both show CONNECTED)") { controller.startRun()?.let { status.text = "cannot start: $it" } }
        btn("Stop / release everything") { controller.stop("operator_stop") }
        btn("Reset for a new attempt") { controller.reset() }
        status = TextView(this).apply { setTypeface(Typeface.MONOSPACE, Typeface.NORMAL); textSize = 12f }
        root.addView(ScrollView(this).apply { addView(status, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT) })
        setContentView(ScrollView(this).apply { addView(root) })
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        val missing = missingPermissions()
        status.text = if (missing.isEmpty()) "all permissions granted" else "still missing: ${missing.joinToString { it.substringAfterLast('.') }}"
    }

    private fun onPair() {
        val missing = missingPermissions()
        if (missing.isNotEmpty()) { status.text = "missing permissions: ${missing.joinToString { it.substringAfterLast('.') }}"; return }
        val role = if (roleSender.isChecked) PairRole.SENDER else PairRole.RECEIVER
        val errs = controller.beginPairing(spinner.selectedItem as String, label.text.toString(), runIdx.text.toString().toIntOrNull() ?: -1, role)
        if (errs.isNotEmpty()) status.text = "CONFIG ERROR:\n" + errs.joinToString("\n")
    }

    private fun needed(): List<String> = PermissionPlan.runtimePermissions(Build.VERSION.SDK_INT)

    private fun missingPermissions() = needed().filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
    private fun requestMissing() { val m = missingPermissions(); if (m.isNotEmpty()) requestPermissions(m.toTypedArray(), 1) else status.text = "all permissions granted" }

    override fun onResume() { super.onResume(); tick() }
    override fun onPause() { ui.removeCallbacksAndMessages(null); super.onPause() }

    private fun tick() {
        val s = controller.snapshot()
        digitsRow.visibility = if (s.digits != null) View.VISIBLE else View.GONE
        digitsText.text = s.digits?.let { "DIGITS: $it" } ?: ""
        status.text = "STAGE: ${s.stage}\n" + s.lines.joinToString("\n") + (s.resultFile?.let { "\nresults: $it" } ?: "")
        ui.postDelayed({ tick() }, 500)
    }
}
